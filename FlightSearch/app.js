//Importing all the libraries
const express = require("express");
var mysql = require("mysql");
const app = express();
const geolib = require("geolib");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
var util = require("util");
const fetch = require("node-fetch");
var timezone = require("node-google-timezone");
dotenv.config();

const port = process.env.port;
app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/assets", express.static("assets"));
app.use(express.static("node_modules"));

//MySQL connection
var con = mysql.createConnection({
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});
con.query = util.promisify(con.query);
var airportList = [];
var dropdownList = [];
var OrgToDestList = [];
var DestToOrgList = [];

// DB Check
con.connect(function(err) {
  if (err) throw err;
  console.log("Connected");
});

// Home page request
app.get("/", function(req, res) {
  res.render("index", {
    list: dropdownList,
    originList: [],
    destList: [],
    error: null,
    flag: false,
    search: {}
  });
});

// API that fetch list of all the Airports to dropdown
app.get("/airports", function(req, res) {
  con.query("SELECT DISTINCT Name,IATA FROM airports ORDER BY Name", function(
    err,
    result,
    fields
  ) {
    if (err) throw err;
    dropdownList = [];
    for (var i = 0; i < result.length; i++) {
      var obj = result[i];
      dropdownList.push({
        label: obj.Name + " (" + obj.IATA + ")",
        value: obj.Name + " (" + obj.IATA + ")"
      });
    }
    res.json(dropdownList);
  });
});

// Search API to get the flight results
app.post("/search", async function(req, res) {
  var OrgIndex = req.body.from.lastIndexOf(" ");
  var DestIndex = req.body.to.lastIndexOf(" ");
  var Org = req.body.from.substring(OrgIndex + 2, req.body.from.length - 1);
  var Dest = req.body.to.substring(DestIndex + 2, req.body.to.length - 1);
  var DeptDate = new Date(req.body.departure).toUTCString();
  var ReturnDate = new Date(req.body.return).toUTCString();
  const d = new Date(DeptDate);
  OrgToDestList = [];
  DestToOrgList = [];
  const now = new Date();
  if (now > d) {
    res.render("index", {
      list: dropdownList,
      originList: OrgToDestList,
      destList: DestToOrgList,
      error: "Departure date cannot be in past",
      flag: false,
      search: req.body
    });
    return;
  }
  const r = new Date(ReturnDate);
  // Calculated UTC time
  var EpochDeptStartDate = Math.round(d.getTime() / 1000);
  var EpochDeptEndDate = EpochDeptStartDate + 86400;
  var EpochReturnStartDate = Math.round(r.getTime() / 1000);
  var EpochReturnEndDate = EpochReturnStartDate + 86400;

  if (EpochDeptStartDate >= EpochReturnStartDate) {
    res.render("index", {
      list: dropdownList,
      originList: OrgToDestList,
      destList: DestToOrgList,
      error: "Please select return date greater than departure date",
      flag: false,
      search: req.body
    });
    return;
  }
  var originDATA = await getOrigin(Org);
  var destinationDATA = await getDestination(Dest);

  //Get list of airports from Origin to destination
  OrgToDestList = await fillList(
    EpochDeptStartDate,
    EpochDeptEndDate,
    originDATA,
    destinationDATA
  );
  //Get list of airports from destination to origin
  DestToOrgList = await fillList(
    EpochReturnStartDate,
    EpochReturnEndDate,
    destinationDATA,
    originDATA
  );
  await nearestAirports(
    originDATA,
    destinationDATA,
    OrgToDestList,
    DestToOrgList,
    EpochDeptStartDate,
    EpochDeptEndDate,
    EpochReturnStartDate,
    EpochReturnEndDate
  );
  res.render("index", {
    list: dropdownList,
    originList: OrgToDestList,
    destList: DestToOrgList,
    error: null,
    flag: true,
    search: req.body
  });
});

// REST API call fetch one fligh from the origin and destination provided
async function getFlight(start, end, org, dest) {
  var flightObj = null;
  var url = `http://asafonov:2f34fc7f817274efd4ecd5a51b2ffd5817b08146@flightxml.flightaware.com/json/FlightXML2/AirlineFlightSchedules?startDate=${start}&endDate=${end}&origin=${org.code}&destination=${dest.code}&howMany=1`;
  console.log(url);
  try {
    const response = await fetch(url);
    const json = await response.json();
    const data = json.AirlineFlightSchedulesResult.data;
    if (data.length > 0) {
      var Ddate = new Date(0);
      Ddate = Ddate.setUTCSeconds(data[0].departuretime);
      var Adate = new Date(0);
      Adate = Adate.setUTCSeconds(data[0].arrivaltime);
      flightObj = {
        ident: data[0].ident,
        departure: new Date(Ddate).toUTCString(),
        arrival: new Date(Adate).toUTCString(),
        origin: org.name + " (" + org.code + ")",
        destination: dest.name + " (" + dest.code + ")",
        aircraftType: data[0].aircrafttype,
        firstSeats: data[0].seats_cabin_first,
        businessSeats: data[0].seats_cabin_business,
        coachSeats: data[0].seats_cabin_coach
      };
    }
  } catch (error) {
    console.log(error);
  }
  return flightObj;
}

//REST API call to fetch all 15 flights from origin to destination
async function fillList(start, end, org, dest) {
  var urlOriginToDest = `http://asafonov:2f34fc7f817274efd4ecd5a51b2ffd5817b08146@flightxml.flightaware.com/json/FlightXML2/AirlineFlightSchedules?startDate=${start}&endDate=${end}&origin=${org.code}&destination=${dest.code}&howMany=15`;
  console.log(urlOriginToDest);
  try {
    const response = await fetch(urlOriginToDest);
    const json = await response.json();
    const data = json.AirlineFlightSchedulesResult.data;
    list = [];
    for (var i = 0; i < data.length; i++) {
      var Ddate = new Date(0);
      Ddate = Ddate.setUTCSeconds(data[i].departuretime);
      var Adate = new Date(0);
      Adate = Adate.setUTCSeconds(data[i].arrivaltime);
      var flightObj = {
        ident: data[i].ident,
        departure: new Date(Ddate).toUTCString(),
        arrival: new Date(Adate).toUTCString(),
        origin: org.name + " (" + org.code + ")",
        destination: dest.name + " (" + dest.code + ")",
        aircraftType: data[i].aircrafttype,
        firstSeats: data[i].seats_cabin_first,
        businessSeats: data[i].seats_cabin_business,
        coachSeats: data[i].seats_cabin_coach
      };
      list.push(flightObj);
    }
  } catch (error) {
    console.log(error);
  }
  return list;
}

// get the origin information
async function getOrigin(origin) {
  var result = await con.query(
    `SELECT * FROM airports WHERE IATA = '${origin}'`
  );
  var ORG = {
    name: result[0].Name,
    latitude: result[0].Latitude,
    longitude: result[0].Longitude,
    id: result[0].ID,
    city: result[0].City,
    code: result[0].IATA
  };
  return ORG;
}

// get the destination information
async function getDestination(destination) {
  var result = await con.query(
    `SELECT * FROM airports WHERE IATA = '${destination}'`
  );
  var DEST = {
    name: result[0].Name,
    latitude: result[0].Latitude,
    longitude: result[0].Longitude,
    id: result[0].ID,
    city: result[0].City,
    code: result[0].IATA
  };
  return DEST;
}

// Function to calculate nearest 10 airports from Origin and Destination
async function nearestAirports(
  origin,
  destination,
  orgToDestList,
  destToOrgList,
  orgStart,
  orgEnd,
  retStart,
  retEnd
) {
  try {
    airportList = [];
    var result = await con.query("SELECT * FROM airports");
    for (var i = 0; i < result.length; i++) {
      var obj = result[i];
      airportList.push({
        name: obj.Name,
        latitude: obj.Latitude,
        longitude: obj.Longitude,
        id: obj.ID,
        city: obj.City,
        code: obj.IATA
      });
    }

    // Sorting the airports according to origin
    var arrSrc = geolib.orderByDistance(
      { latitude: origin.latitude, longitude: origin.longitude },
      airportList
    );

    // Sorting the airports according to destination
    var arrDest = geolib.orderByDistance(
      { latitude: destination.latitude, longitude: destination.longitude },
      airportList
    );

    // REST API call to get flight details for nearest airports
    for (var i = 1; i <= 15; i++) {
      var flight1 = await getFlight(orgStart, orgEnd, origin, arrDest[i]);
      if (flight1) {
        orgToDestList.push(flight1);
      }
      var flight2 = await getFlight(retStart, retEnd, destination, arrSrc[i]);
      if (flight2) {
        destToOrgList.push(flight2);
      }
    }
  } catch (error) {
    console.log(error);
  }
}

// created local server to run the application
app.listen(port, () => console.log(`Example app listening on port ${port}`));
module.exports = app;
