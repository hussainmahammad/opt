const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

const {
  JENKINS_URL,
  JENKINS_USER,
  JENKINS_API_TOKEN,
  AWS_REGION
} = process.env;

const auth = {
  username: JENKINS_USER,
  password: JENKINS_API_TOKEN
};

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

/* =========================================================
   Helpers
========================================================= */

function normalize(status) {
  if (status === "IN_PROGRESS") return "RUNNING";
  if (status === "SUCCESS") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  if (status === "ABORTED") return "FAILED";
  return "PENDING";
}

const UI_PHASES = [
  "Prepare",
  "Build",
  "Setup",
  "Deploy",
  "Validate",
  "Complete"
];

/*
GET /phases/:deploymentId?type=deploy|destroy
*/

router.get("/phases/:deploymentId", async (req, res) => {
  try {
    const { deploymentId } = req.params;
    const type = req.query.type || "deploy";

    /* ===== 1. Validate type ===== */

    if (!["deploy", "destroy"].includes(type)) {
      return res.status(400).json({
        error: "type must be deploy or destroy"
      });
    }

    /* ===== 2. Fetch deployment ===== */

    const depRes = await dynamodb.get({
      TableName: "Deployments",
      Key: { deploymentId }
    }).promise();

    if (!depRes.Item) {
      return res.status(404).json({
        error: "Deployment not found"
      });
    }

    const deployment = depRes.Item;

    /* ===== 3. Select job & build ===== */

    const jobName =
      type === "destroy"
        ? deployment.destroyJobName
        : deployment.deployJobName;

    const buildNumber =
      type === "destroy"
        ? deployment.destroyBuildNumber
        : deployment.deployBuildNumber;

    /* ===== 4. Build not started ===== */

    if (!buildNumber || buildNumber === "NA") {
      return res.json({
        deploymentId,
        type,
        job: jobName,
        buildNumber: null,
        phases: UI_PHASES.map(p => ({
          name: p,
          status: "PENDING"
        })),
        message: "Build not started yet"
      });
    }

    /* ===== 5. Fetch Jenkins stages ===== */

    let stages = [];

    try {
      const wf = await axios.get(
        `${JENKINS_URL}/job/${jobName}/${buildNumber}/wfapi/describe`,
        { auth }
      );

      stages = wf.data.stages || [];
    } catch (e) {
      // wfapi may not be ready yet
      return res.json({
        deploymentId,
        type,
        job: jobName,
        buildNumber,
        phases: UI_PHASES.map(p => ({
          name: p,
          status: "PENDING"
        })),
        message: "Stages not available yet"
      });
    }

    /* ===== 6. Map to UI phases ===== */

    const phases = UI_PHASES.map(p => ({
      name: p,
      status: "PENDING"
    }));

    stages.forEach(stage => {
      const idx = UI_PHASES.indexOf(stage.name);
      if (idx !== -1) {
        phases[idx].status = normalize(stage.status);
      }
    });

    /* ===== 7. Response ===== */

    res.json({
      deploymentId,
      type,
      job: jobName,
      buildNumber,
      phases
    });

  } catch (err) {
    console.error("Phases error:", err.message);

    res.status(500).json({
      error: "Failed to fetch phases"
    });
  }
});

module.exports = router;
