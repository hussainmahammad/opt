const router = require("express").Router();
const axios = require("axios");
const AWS = require("aws-sdk");

const { JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN, AWS_REGION } = process.env;
const auth = { username: JENKINS_USER, password: JENKINS_API_TOKEN };

AWS.config.update({ region: AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function getCrumb() {
  const r = await axios.get(`${JENKINS_URL}/crumbIssuer/api/json`, { auth });
  return { [r.data.crumbRequestField]: r.data.crumb };
}

router.post("/stop", async (req, res) => {
  const { appId } = req.body;

  try {
    const appRes = await dynamodb.get({
      TableName: "Applications",
      Key: { appId }
    }).promise();

    if (!appRes.Item) {
      return res.status(404).json({ error: "App not found" });
    }

    const jobName = appRes.Item.deployJobName;

    const buildRes = await axios.get(
      `${JENKINS_URL}/job/${jobName}/lastBuild/api/json`,
      { auth }
    );

    const { number, building } = buildRes.data;

    if (!building) {
      return res.json({ status: "ALREADY_FINISHED" });
    }

    const crumbHeader = await getCrumb();

    try {
      await axios.post(
        `${JENKINS_URL}/job/${jobName}/${number}/stop`,
        {},
        { auth, headers: crumbHeader }
      );
    } catch (e) {
      console.warn("Stop request returned error, ignoring:", e.response?.status);
    }

    return res.json({ status: "STOPPED" });

  } catch (err) {
    console.error("Stop fatal error:", err.response?.status, err.message);
    return res.status(500).json({ error: "Failed to stop pipeline" });
  }
});

module.exports = router;
