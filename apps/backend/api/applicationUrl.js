const express = require("express");
const AWS = require("aws-sdk");

const router = express.Router();

const { AWS_REGION } = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();

// GET application URL from Deployments table
router.get("/application-url/:deploymentId", async (req, res) => {
  const { deploymentId } = req.params;

  try {
    const result = await dynamodb.get({
      TableName: "Deployments",
      Key: { deploymentId }
    }).promise();

    if (!result.Item) {
      return res.status(404).json({ error: "Deployment not found" });
    }

    if (!result.Item.publicIp) {
      return res.status(409).json({
        error: "Instance not created yet",
        status: result.Item.status,
        completedAt: result.Item.completedAt || null
      });
    }

    res.json({
      url: `http://${result.Item.publicIp}`,
      status: result.Item.status,
      appId: result.Item.appId,
      completedAt: result.Item.completedAt || null
    });

  } catch (err) {
    console.error("application-url error:", err);
    res.status(500).json({ error: "Failed to fetch application URL" });
  }
});

module.exports = router;
