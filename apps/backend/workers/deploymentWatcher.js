const axios = require("axios");

const {
  JENKINS_URL,
  JENKINS_USER,
  JENKINS_API_TOKEN
} = process.env;

const auth = {
  username: JENKINS_USER,
  password: JENKINS_API_TOKEN
};

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* =======================================================
   Extract values from Jenkins console output
   Now supports OBS_* format printed by pipeline
======================================================= */

function extractValue(logs, key) {
  const match = logs.match(new RegExp(`${key}=(.*)`));
  return match ? match[1].trim() : "NA";
}

async function extractDeploymentInfo(jobName, buildNumber, runtime) {
  try {
    const logRes = await axios.get(
      `${JENKINS_URL}/job/${jobName}/${buildNumber}/consoleText`,
      { auth }
    );

    const logs = logRes.data;

    /* ===================================================
       Read OBS values (printed by Jenkins)
    =================================================== */

    const info = {
      endpointUrl: extractValue(logs, "OBS_ENDPOINT"),

      logGroupAccess: extractValue(logs, "OBS_LOG_GROUP_ACCESS"),
      logGroupError: extractValue(logs, "OBS_LOG_GROUP_ERROR"),
      logGroup: extractValue(logs, "OBS_LOG_GROUP"),

      asgName: extractValue(logs, "OBS_ASG"),

      clusterName: extractValue(logs, "OBS_CLUSTER"),
      namespace: extractValue(logs, "OBS_NAMESPACE"),
      deploymentName: extractValue(logs, "OBS_DEPLOYMENT"),

      metricsEnabled:
        extractValue(logs, "OBS_METRICS_ENABLED") === "true",

      metricsType: extractValue(logs, "OBS_METRICS_TYPE")
    };

    /* ===================================================
       Runtime safety defaults
    =================================================== */

    if (runtime === "ec2") {
      info.metricsEnabled = true;
      info.metricsType = "ec2";
    }

    if (runtime === "eks-fargate") {
      info.metricsEnabled = false;
      info.metricsType = "NA";
    }

    if (runtime === "eks-ec2") {
      info.metricsEnabled = true;
      info.metricsType = "eks";
    }

    return info;

  } catch (err) {
    console.error("Console parsing failed:", err.message);
    return {};
  }
}

/* =======================================================
   Deployment Watcher
======================================================= */

async function watchDeployment({
  deploymentId,
  jobName,
  buildNumber,
  runtime,
  updateDeployment
}) {
  console.log("Deploy watcher started:", deploymentId);

  while (true) {
    try {
      const buildRes = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/api/json`,
        { auth }
      );

      /* ---------- Wait until build finishes ---------- */
      if (!buildRes.data.building) {
        const result = buildRes.data.result || "FAILED";

        /* ---------- FAILED ---------- */
        if (result !== "SUCCESS") {
          await updateDeployment(deploymentId, {
            status: "FAILED",
            completedAt: new Date().toISOString(),
            deployBuildNumber: buildNumber
          });

          console.log("Deployment FAILED:", deploymentId);
          break;
        }

        /* ---------- SUCCESS ---------- */

        const info = await extractDeploymentInfo(
          jobName,
          buildNumber,
          runtime
        );

        const payload = {
          status: "RUNNING",
          completedAt: new Date().toISOString(),
          deployBuildNumber: buildNumber,

          endpointUrl: info.endpointUrl || "NA",

          logGroupAccess: info.logGroupAccess || "NA",
          logGroupError: info.logGroupError || "NA",
          logGroup: info.logGroup || "NA",

          metricsEnabled:
            typeof info.metricsEnabled === "boolean"
              ? info.metricsEnabled
              : false,

          metricsType: info.metricsType || "NA",

          asgName: info.asgName || "NA",

          clusterName: info.clusterName || "NA",
          namespace: info.namespace || "NA",
          deploymentName: info.deploymentName || "NA"
        };

        console.log("Deployment SUCCESS update:", payload);

        await updateDeployment(deploymentId, payload);
        break;
      }

    } catch (err) {
      console.error("Watcher error:", err.message);
    }

    await wait(10000);
  }
}

module.exports = { watchDeployment };
