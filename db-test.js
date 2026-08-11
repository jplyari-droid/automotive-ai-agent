require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function testDatabase() {
  try {
    const result = await pool.query(
      "SELECT NOW() AS current_time"
    );

    console.log("Database connected successfully!");
    console.log("Database time:", result.rows[0].current_time);

  } catch (error) {
  console.error("Database connection failed:");
  console.error(error);

  } finally {
    await pool.end();
  }
}

testDatabase();