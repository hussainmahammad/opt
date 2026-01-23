const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

const { JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN, AWS_REGION } = process.env;
const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

function normalize(status) {
  if (status === "IN_PROGRESS") return "RUNNING";
  if (status === "SUCCESS") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  return "PENDING";
}

router.get("/phases/:appId", async (req, res) => {
  try {
    const { appId } = req.params;
    const type = req.query.type || "deploy";

    const appRes = await dynamodb.get({
      TableName: "Applications",
      Key: { appId }
    }).promise();

    if (!appRes.Item) return res.status(404).json({ error: "App not found" });

    const jobName =
      type === "destroy"
        ? appRes.Item.destroyJobName
        : appRes.Item.deployJobName;

    const wf = await axios.get(
      `${JENKINS_URL}/job/${jobName}/lastBuild/wfapi/describe`,
      { auth }
    );

    const UI_PHASES = ["Prepare", "Build", "Setup", "Deploy", "Validate", "Complete"];
    const phases = UI_PHASES.map(p => ({ name: p, status: "PENDING" }));

    wf.data.stages.forEach(stage => {
      const i = UI_PHASES.indexOf(stage.name);
      if (i !== -1) phases[i].status = normalize(stage.status);
    });

    res.json({ appId, type, job: jobName, phases });

  } catch (err) {
    console.error("Phases error:", err.message);
    res.status(500).json({ error: "Failed to fetch phases" });
  }
});

module.exports = router;
