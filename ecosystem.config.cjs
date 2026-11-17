module.exports = {
    apps: [
        {
            name: "Magalu-To-DB-Order",

            cwd: "/home/sandbox/MagaLu-To-DB-Order",
            script: "/home/sandbox/MagaLu-To-DB-Order/build/index.js",
            interpreter: "/home/kelvin/.bun/bin/bun",
            exec_mode: "fork",

            cron_restart: "0 */2 * * *",

            autorestart: true,
            exp_backoff_restart_delay: 1_000,
            stop_exit_codes: [0],
            max_restarts: 10,

            time: true
        }
    ]
};
