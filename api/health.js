import { db } from "hatchable";

export const access = "public";
export const methods = ["GET"];

export default async function (req, res) {
  try {
    const result = await db.query("SELECT NOW() AS server_time, current_database() AS database_name");
    res.json({ status:"ok", service:"taskops-api", database:"connected", server_time:result.rows[0].server_time });
  } catch (error) {
    res.status(503).json({ status:"degraded", service:"taskops-api", database:"unavailable" });
  }
}