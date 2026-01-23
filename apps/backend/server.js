require("dotenv").config();
const express = require("express");
const cors = require("cors");

const autoDestroyModule = require("./workers/autoDestroyWorker");
const startAutoDestroyWorker =
  typeof autoDestroyModule === "function"
    ? autoDestroyModule
    : autoDestroyModule.startAutoDestroyWorker;

const app = express();

app.use(cors());            // Allow all origins
app.use(express.json());

app.use("/", require("./api/health.api"));
app.use("/api", require("./api/deploy.api"));
app.use("/api", require("./api/destroy.api"));
app.use("/api", require("./api/stop.api"));
app.use("/api", require("./api/phases.api"));
app.use("/api", require("./api/jenkinsLogs.api"));
app.use("/api", require("./api/appLogs.api"));
app.use("/api", require("./api/metrics.api"));
app.use("/api", require("./api/logsSse")); 
app.use("/api", require("./api/applicationUrl")); 

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);

  if (typeof startAutoDestroyWorker === "function") {
    startAutoDestroyWorker();
  } else {
    console.error(
      "❌ Auto-destroy worker not started. Export is:",
      autoDestroyModule
    );
  }
});
