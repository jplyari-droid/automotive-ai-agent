require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function checkRecords() {
  try {
    const result = await pool.query(`
      SELECT
        case_id,
        record_type,
        user_question,
        created_at
      FROM diagnostic_records
      ORDER BY id DESC
      LIMIT 5
    `);

    console.log("");
    console.log("Latest diagnostic records:");
    console.log("");

    console.table(result.rows);

  } catch (error) {
    console.error(
      "Database check failed:",
      error
    );
  } finally {
    await pool.end();
  }
}

checkRecords();