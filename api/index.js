const express = require("express");
try {
  require("dotenv").config({ path: ".env.local" });
} catch (e) {}
const cors = require("cors");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");
const serverless = require("serverless-http");

const app = express();

const MONGO_URL =
  process.env.MONGODB_URL ||
  process.env.MONGO_URL;
const MONGO_DB = process.env.MONGODB_DB;
const apiKey =
  process.env.API_Key;
const MAIL_FROM_EMAIL =
  process.env.MAIL_FROM_EMAIL;
const MAIL_FROM_PASS = process.env.MAIL_FROM_PASS;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME;
const MAIL_TO_EMAIL =
  process.env.MAIL_TO_EMAIL;
const MAIL_TO_NAME = process.env.MAIL_TO_NAME;

let mongoClient = null;
let mongoDb = null;
let mailTransporter = null;

async function connectToMongo() {
  if (!MONGO_URL) return null;
  if (mongoDb) return mongoDb;
  try {
    mongoClient = new MongoClient(MONGO_URL, {
      retryWrites: true,
      w: "majority",
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    await mongoClient.connect();
    await mongoClient.db("admin").command({ ping: 1 });
    mongoDb = mongoClient.db(MONGO_DB);
    return mongoDb;
  } catch (err) {
    mongoClient = null;
    mongoDb = null;
    return null;
  }
}

function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  if (!MAIL_FROM_EMAIL || !MAIL_FROM_PASS) return null;
  mailTransporter = nodemailer.createTransport({
    host: MAIL_FROM_EMAIL,
    port: 465,
    secure: true,
    auth: { user: MAIL_FROM_EMAIL, pass: MAIL_FROM_PASS },
  });
  return mailTransporter;
}

app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== apiKey) return res.status(403).send("Forbidden");
  next();
});

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json({ limit: "5mb" }));

// Order processing (reduce batches + email)
app.post("/api/orders/:companyName/:shopName", async (req, res) => {
  try {
    const { companyName, shopName } = req.params;
    const orderItems = req.body;
    if (!companyName || !shopName)
      return res.status(400).json({
        success: false,
        error: "companyName and shopName are required",
      });
    if (!Array.isArray(orderItems) || orderItems.length === 0)
      return res.status(400).json({
        success: false,
        error: "Request body must be a non-empty array of items",
      });
    for (const item of orderItems) {
      if (!item.stockItem)
        return res.status(400).json({
          success: false,
          error: "Each item must have a stockItem field",
        });
      if (!item.pieces || typeof item.pieces !== "object")
        return res.status(400).json({
          success: false,
          error: "Each item must have a pieces object",
        });
    }
    const mongo = await connectToMongo();
    if (!mongo)
      return res
        .status(503)
        .json({ success: false, error: "MongoDB not configured" });
    const batchesCol = mongo.collection("stockBatches");
    const processedItems = [];
    for (const item of orderItems) {
      const { stockItem, pieces } = item;
      const batchDoc = await batchesCol.findOne({ companyName, stockItem });
      if (!batchDoc)
        return res.status(404).json({
          success: false,
          error: `No batches found for stockItem "${stockItem}" in company "${companyName}"`,
        });
      const itemBatches = batchDoc.batches || [];
      const orderedBatches = [];
      for (const [batchSizeKey, requestedQty] of Object.entries(pieces)) {
        const batchSize = parseInt(batchSizeKey);
        const quantity = parseInt(requestedQty);
        if (quantity <= 0) continue;
        const matchingBatch = itemBatches.find((b) => b.size === batchSize);
        if (!matchingBatch)
          return res.status(400).json({
            success: false,
            error: `Batch size ${batchSize} not found for stockItem "${stockItem}"`,
          });
        if (matchingBatch.quantity < quantity)
          return res.status(400).json({
            success: false,
            error: `Insufficient quantity for batch size ${batchSize}. Available: ${matchingBatch.quantity}, Requested: ${quantity}`,
          });
        orderedBatches.push({
          size: batchSize,
          orderedQty: quantity,
          availableQty: matchingBatch.quantity,
        });
      }
      if (orderedBatches.length === 0)
        return res.status(400).json({
          success: false,
          error: `No valid pieces provided for stockItem "${stockItem}"`,
        });
      for (const ob of orderedBatches) {
        await batchesCol.updateOne(
          { companyName, stockItem, "batches.size": ob.size },
          { $inc: { "batches.$.quantity": -ob.orderedQty } },
        );
      }
      const totalOrderedForItem = orderedBatches.reduce(
        (sum, b) => sum + b.orderedQty,
        0,
      );
      await batchesCol.updateOne(
        { companyName, stockItem },
        {
          $inc: { totalQuantity: -totalOrderedForItem },
          $set: { updatedAt: new Date() },
        },
      );
      const _updatedDoc = await batchesCol.findOne(
        { companyName, stockItem },
        { projection: { totalQuantity: 1, batches: 1, updatedAt: 1 } },
      );
      processedItems.push({
        stockItem,
        orderedBatches,
        totalPieces: orderedBatches.reduce((sum, b) => sum + b.orderedQty, 0),
        totals: {
          totalQuantity: _updatedDoc?.totalQuantity || 0,
          batchCount: (_updatedDoc?.batches || []).length,
          updatedAt: _updatedDoc?.updatedAt,
        },
      });
    }
    const totalCountAllPieces = processedItems.reduce(
      (sum, item) => sum + item.totalPieces,
      0,
    );
    try {
      const transporter = getMailTransporter();
      if (transporter) {
        let tableRows = "";
        for (const item of processedItems) {
          const batchSizes = item.orderedBatches
            .map((b) => b.size)
            .sort((a, b) => a - b)
            .join(", ");
          tableRows += `<tr>
            <td style="padding:8px;border:1px solid #ddd">${item.stockItem}</td>
            <td style="padding:8px;border:1px solid #ddd;text-align:center">${batchSizes}</td>
            <td style="padding:8px;border:1px solid #ddd;text-align:right">
              ${item.orderedBatches.map((b) => "Size " + b.size + ": " + b.orderedQty).join("<br/>")}
            </td>
          </tr>`;
        }
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;background:#f9f9f9;padding:20px;border-radius:8px">
            <h2 style="color:#333;border-bottom:3px solid #2196F3;padding-bottom:10px">Order Confirmation</h2>
            <div style="background:white;padding:15px;margin:15px 0;border-radius:4px;border-left:4px solid #2196F3">
              <p style="margin:5px 0"><strong>Company:</strong> ${companyName}</p>
              <p style="margin:5px 0"><strong>Shop Name:</strong> ${shopName}</p>
              <p style="margin:5px 0"><strong>Total Count:</strong> <span style="font-size:18px;color:#2196F3;font-weight:bold">${totalCountAllPieces}</span></p>
              <p style="margin:5px 0"><strong>Order Date:</strong> ${new Date().toLocaleString()}</p>
            </div>
            <h3 style="color:#333;margin-top:20px">Order Items</h3>
            <table style="border-collapse:collapse;width:100%;background:white">
              <thead>
                <tr style="background:#2196F3;color:white">
                  <th style="padding:10px;border:1px solid #ddd;text-align:left">Stock Item</th>
                  <th style="padding:10px;border:1px solid #ddd;text-align:center">Batch Sizes</th>
                  <th style="padding:10px;border:1px solid #ddd;text-align:right">Quantity by Batch</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
            <div style="background:#e3f2fd;padding:15px;margin-top:20px;border-radius:4px;border-left:4px solid #2196F3">
              <p style="margin:0;color:#333"><strong>✓ Order processed and batches updated.</strong></p>
            </div>
            <p style="font-size:12px;color:#999;margin-top:20px;text-align:center">Automated message</p>
          </div>`;
        const textLines = [
          "ORDER CONFIRMATION",
          `Company: ${companyName}`,
          `Shop: ${shopName}`,
          `Total Count: ${totalCountAllPieces}`,
          "ORDER ITEMS:",
          ...processedItems.flatMap((item) =>
            item.orderedBatches.map(
              (b) =>
                `Stock Item: ${item.stockItem} | Size ${b.size}: ${b.orderedQty} units`,
            ),
          ),
        ];
        await transporter.sendMail({
          from: `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`,
          to: MAIL_TO_EMAIL,
          subject: `Order: Shop: ${shopName} — Company: ${companyName}`,
          text: textLines.join("\n"),
          html,
        });
      }
    } catch (mailErr) {
      // ignore email failures
    }
    res.json({
      success: true,
      message: `Order placed and stock batches updated successfully for ${shopName}`,
      companyName,
      items: processedItems,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Punch-in
app.post("/api/punch-in", async (req, res) => {
  try {
    const {
      employeeName,
      employeePhone,
      companyName,
      shopName,
      amount,
      location,
      time,
      date,
    } = req.body;
    if (!employeeName)
      return res
        .status(400)
        .json({ success: false, error: "Employee name is required" });
    if (!employeePhone)
      return res
        .status(400)
        .json({ success: false, error: "Employee phone is required" });
    if (!companyName)
      return res
        .status(400)
        .json({ success: false, error: "Company name is required" });
    if (!shopName)
      return res
        .status(400)
        .json({ success: false, error: "Shop name is required" });
    if (!amount || isNaN(amount) || amount <= 0)
      return res
        .status(400)
        .json({ success: false, error: "Valid amount is required" });
    if (!time)
      return res
        .status(400)
        .json({ success: false, error: "Time is required" });
    if (!date)
      return res
        .status(400)
        .json({ success: false, error: "Date is required" });
    const transporter = getMailTransporter();
    if (!transporter)
      return res.status(500).json({
        success: false,
        error: "Email service not configured on server",
      });
    const emailSubject = `Punch In - ${employeeName} - ${shopName} - ${date}`;
    const emailHtml = `
      <!DOCTYPE html><html><head><style>
        body{font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px}
        .header{background-color:#780206;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0}
        .content{background-color:#f9f9f9;padding:20px;border:1px solid #ddd;border-top:none;border-radius:0 0 8px 8px}
        table{border-collapse:collapse;width:100%;margin-top:20px;background-color:white}
        th{background-color:#780206;color:white;padding:12px;text-align:left;font-weight:bold}
        td{padding:12px;border-bottom:1px solid #ddd}
        tr:last-child td{border-bottom:none}
        .label{font-weight:bold;color:#555;width:40%}.value{color:#333}.amount{font-size:18px;font-weight:bold;color:#780206}
        .footer{margin-top:20px;text-align:center;font-size:12px;color:#666}
      </style></head><body>
        <div class="header"><h1 style="margin:0;">New Punch In Record</h1><p style="margin:5px 0 0 0;">Cochin Traders</p></div>
        <div class="content">
          <table>
            <tr><td class="label">Employee Name:</td><td class="value">${employeeName}</td></tr>
            <tr><td class="label">Phone Number:</td><td class="value">${employeePhone}</td></tr>
            <tr><td class="label">Company Name:</td><td class="value">${companyName}</td></tr>
            <tr><td class="label">Shop Name:</td><td class="value">${shopName}</td></tr>
            <tr><td class="label">Amount:</td><td class="value amount">₹${Number(amount).toLocaleString("en-IN")}</td></tr>
            <tr><td class="label">Date:</td><td class="value">${date}</td></tr>
            <tr><td class="label">Time:</td><td class="value">${time}</td></tr>
          </table>
          <div class="footer"><p>This is an automated email from Cochin Traders Punch In System</p>
          <p>Sent on ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "long" })}</p></div>
        </div>
      </body></html>`;
    const emailText = `
      New Punch In Record - Cochin Traders
      Employee Name: ${employeeName}
      Phone Number: ${employeePhone}
      Company Name: ${companyName}
      Shop Name: ${shopName}
      Amount: ₹${Number(amount).toLocaleString("en-IN")}
      Location: ${location}
      Date: ${date}
      Time: ${time}
      ---
      This is an automated email from Cochin Traders Punch In System
    `;
    await transporter.sendMail({
      from: `"${MAIL_FROM_NAME}" <${MAIL_FROM_EMAIL}>`,
      to: `"${MAIL_TO_NAME}" <${MAIL_TO_EMAIL}>`,
      subject: emailSubject,
      html: emailHtml,
      text: emailText,
    });
    res.json({
      success: true,
      message: "Punch in recorded and email sent successfully",
      data: { employeeName, shopName, amount, location, date, time },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to process punch in. Please try again.",
    });
  }
});

module.exports = serverless(app);
module.exports.app = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Local server running at http://localhost:${PORT}`);
  });
}
