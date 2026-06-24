module.exports = {
  apps : [{
    name: "baileys-api",
    script: "./index.js",
    mode: "fork",
    instances: 1,
    autorestart: true,
    max_memory_restart: "250M", // Perfect threshold for low memory environments
    restart_delay: 5000,        // Wait 5 seconds before trying to reconnect on crashes
    env: {
      PORT: 3000,
      NODE_ENV: "production",
	DB_HOST: "127.0.0.1",
  	DB_PORT: 3306,
  	DB_USER: "root",
  	DB_PASSWORD: "bio!102938",
  	DB_NAME: "baileys_manager"
    }
  }]
};
