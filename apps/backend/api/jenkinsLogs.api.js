const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

const { JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN, AWS_REGION } = process.env;
const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

router.get("/jenkins-logs/:appId", async (req, res) => {
  try {
    const { appId } = req.params;
    const type = req.query.type || "deploy";
    const offset = Number(req.query.from || 0);

    const appRes = await dynamodb.get({
      TableName: "Applications",
      Key: { appId }
    }).promise();

    if (!appRes.Item) return res.status(404).json({ error: "App not found" });

    const jobName =
      type === "destroy"
        ? appRes.Item.destroyJobName
        : appRes.Item.deployJobName;

    const build = await axios.get(
      `${JENKINS_URL}/job/${jobName}/lastBuild/api/json`,
      { auth }
    );

    const r = await axios.get(
      `${JENKINS_URL}/job/${jobName}/${build.data.number}/logText/progressiveText?start=${offset}`,
      { auth }
    );

    res.json({
      appId,
      type,
      job: jobName,
      logs: r.data || "",
      nextOffset: Number(r.headers["x-text-size"] || offset),
      complete: r.headers["x-more-data"] !== "true"
    });

  } catch (err) {
    console.error("Logs error:", err.message);
    res.status(500).json({ error: "Failed to fetch Jenkins logs" });
  }
});

module.exports = router;
