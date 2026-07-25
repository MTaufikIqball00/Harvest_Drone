import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

function getEnv(name: string, fallback: string = ""): string {
  return process.env[name] || process.env[`DRONE_${name}`] || fallback;
}

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: getEnv("DB_HOST", "127.0.0.1"),
      port: Number(getEnv("DB_PORT", "3306")),
      user: getEnv("DB_USER", "drone_app"),
      password: getEnv("DB_PASSWORD", "change-this-password"),
      database: getEnv("DB_NAME", "drone_ops"),
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
      queueLimit: 0,
      decimalNumbers: true,
      enableKeepAlive: true,
    });
  }
  return pool;
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const p = getPool();
  const [rows] = await p.execute(sql, params);
  return rows as T[];
}
