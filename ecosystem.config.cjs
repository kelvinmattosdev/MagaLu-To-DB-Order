module.exports = {
    apps: [
        {
            name: "Magalu-To-DB-Orders",

            cwd: "/home/desenvolvedor/Desenvolvedores/kelvinho/Magalu-To-DB",
            script: "/home/desenvolvedor/Desenvolvedores/kelvinho/Magalu-To-DB/build/index.js",
            interpreter: "bun",
            exec_mode: "fork",

            cron_restart: "0 8,10,14,18 * * *",

            autorestart: true,
            exp_backoff_restart_delay: 1_000,
            stop_exit_codes: [0],
            max_restarts: 10,

            out_file: "/home/desenvolvedor/.pm2/logs/Magalu-To-DB-Orders-out.log",
            error_file: "/home/desenvolvedor/.pm2/logs/Magalu-To-DB-Orders-error.log",
            time: true
        }
    ]
};
