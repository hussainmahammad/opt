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

/*
GET /jenkins-logs/:deploymentId?type=deploy|destroy&from=0
*/

router.get("/jenkins-logs/:deploymentId", async (req, res) => {
  try {
    const { deploymentId } = req.params;
    const type = req.query.type || "deploy";
    const offset = Number(req.query.from || 0);

    /* ===== 1. Validate type ===== */

    if (!["deploy", "destroy"].includes(type)) {
      return res.status(400).json({
        error: "type must be deploy or destroy"
      });
    }

    /* ===== 2. Get deployment ===== */

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
        logs: "",
        nextOffset: offset,
        complete: false,
        message: "Build not started yet"
      });
    }

    /* ===== 5. Fetch progressive logs ===== */

    const response = await axios.get(
      `${JENKINS_URL}/job/${jobName}/${buildNumber}/logText/progressiveText?start=${offset}`,
      { auth }
    );

    const logs = response.data || "";
    const nextOffset = Number(response.headers["x-text-size"] || offset);
    const moreData = response.headers["x-more-data"] === "true";

    res.json({
      deploymentId,
      type,
      job: jobName,
      buildNumber,
      logs,
      nextOffset,
      complete: !moreData
    });

  } catch (err) {
    console.error("Jenkins logs error:", err.message);

    res.status(500).json({
      error: "Failed to fetch Jenkins logs"
    });
  }
});

module.exports = router;
