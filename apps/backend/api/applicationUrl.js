const express = require("express");
const AWS = require("aws-sdk");

const router = express.Router();

const { AWS_REGION } = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();

/*
GET /application-url/:deploymentId

Returns application endpoint (ALB / Ingress)
*/

router.get("/application-url/:deploymentId", async (req, res) => {
  const { deploymentId } = req.params;

  try {
    /* ===== 1. Fetch deployment ===== */

    const result = await dynamodb.get({
      TableName: "Deployments",
      Key: { deploymentId }
    }).promise();

    const deployment = result.Item;

    if (!deployment) {
      return res.status(404).json({
        error: "Deployment not found"
      });
    }

    const {
      status,
      endpointUrl,
      runtime,
      appId,
      appName,
      completedAt
    } = deployment;

    /* ===== 2. Handle status cases ===== */

    if (status === "FAILED") {
      return res.status(400).json({
        error: "Deployment failed",
        status
      });
    }

    if (status === "DESTROYED") {
      return res.status(400).json({
        error: "Application destroyed",
        status
      });
    }

    if (status === "QUEUED" || status === "DEPLOYING") {
      return res.status(409).json({
        error: "Application not ready yet",
        status,
        completedAt: completedAt || null
      });
    }

    /* ===== 3. RUNNING but endpoint not yet recorded ===== */

    if (!endpointUrl || endpointUrl === "NA") {
      return res.status(409).json({
        error: "Endpoint not available yet",
        status,
        completedAt: completedAt || null
      });
    }

    /* ===== 4. Success ===== */

    res.json({
      deploymentId,
      appId,
      appName,
      runtime,
      url: endpointUrl,
      status,
      completedAt: completedAt || null
    });

  } catch (err) {
    console.error("application-url error:", err.message);
    res.status(500).json({
      error: "Failed to fetch application URL"
    });
  }
});

module.exports = router;
