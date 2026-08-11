require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function upgradeDatabase() {
  try {
    console.log("Upgrading automotive database...");

    await pool.query(`
      ALTER TABLE vehicle_cases
      ADD COLUMN IF NOT EXISTS chassis_number VARCHAR(100);
    `);

    await pool.query(`
      ALTER TABLE vehicle_cases
      ADD COLUMN IF NOT EXISTS model_code VARCHAR(100);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_cases_chassis
      ON vehicle_cases(chassis_number);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_cases_model_code
      ON vehicle_cases(model_code);
    `);

    console.log("");
    console.log("Database upgrade successful!");
    console.log("");
    console.log("Vehicle search now supports:");
    console.log("VIN");
    console.log("Frame / Chassis Number");
    console.log("Model Code");

  } catch (error) {
    console.error(
      "Database upgrade failed:"
    );

    console.error(error);

  } finally {
    await pool.end();
  }
}

upgradeDatabase();