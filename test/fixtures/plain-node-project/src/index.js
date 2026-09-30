const express = require("express");
const app = express();
app.get("/", (_req, res) => res.send("hello"));
app.listen(3000);
