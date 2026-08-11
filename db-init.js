require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  try {
    console.log("Connecting to database...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_cases (
        id SERIAL PRIMARY KEY,
        case_id VARCHAR(50) UNIQUE NOT NULL,
        vin VARCHAR(50),
        make VARCHAR(100),
        model VARCHAR(100),
        year VARCHAR(20),
        engine_code VARCHAR(100),
        transmission VARCHAR(100),
        mileage VARCHAR(50),
        symptoms TEXT,
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("vehicle_cases table ready.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS diagnostic_records (
        id SERIAL PRIMARY KEY,
        case_id VARCHAR(50) NOT NULL,
        record_type VARCHAR(50),
        user_question TEXT,
        ai_answer TEXT,
        file_name TEXT,
        openai_response_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT fk_case
          FOREIGN KEY (case_id)
          REFERENCES vehicle_cases(case_id)
          ON DELETE CASCADE
      );
    `);

    console.log("diagnostic_records table ready.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS dtc_records (
        id SERIAL PRIMARY KEY,
        case_id VARCHAR(50) NOT NULL,
        module VARCHAR(100),
        dtc_code VARCHAR(50),
        description TEXT,
        dtc_status VARCHAR(50),
        priority VARCHAR(50),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT fk_dtc_case
          FOREIGN KEY (case_id)
          REFERENCES vehicle_cases(case_id)
          ON DELETE CASCADE
      );
    `);

    console.log("dtc_records table ready.");

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_cases_vin
      ON vehicle_cases(vin);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_diagnostic_records_case
      ON diagnostic_records(case_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_dtc_records_case
      ON dtc_records(case_id);
    `);

    console.log("");
    console.log("================================");
    console.log("Database initialization complete!");
    console.log("================================");
    console.log("");
    console.log("Tables created:");
    console.log("1. vehicle_cases");
    console.log("2. diagnostic_records");
    console.log("3. dtc_records");

  } catch (error) {
    console.error("Database initialization failed:");
    console.error(error);

  } finally {
    await pool.end();
  }
}

initDatabase();