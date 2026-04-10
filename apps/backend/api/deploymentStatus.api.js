const router = require("express").Router();
const AWS = require("aws-sdk");

const { AWS_REGION } = process.env;

AWS.config.update({ region: AWS_REGION || "us-east-1" });

const dynamodb = new AWS.DynamoDB.DocumentClient();

/*
GET /deployment-status/:deploymentId
*/

router.get("/deployment-status/:deploymentId", async (req, res) => {

  const { deploymentId } = req.params;

  if (!deploymentId) {
    return res.status(400).json({
      error: "deploymentId required"
    });
  }

  try {

    const result = await dynamodb.get({
      TableName: "Deployments",
      Key: { deploymentId }
    }).promise();

    if (!result.Item) {
      return res.status(404).json({
        error: "Deployment not found"
      });
    }

    res.json(result.Item);

  } catch (err) {

    console.error("Deployment status error:", err.message);

    res.status(500).json({
      error: "Failed to fetch deployment status"
    });

  }

});

module.exports = router;