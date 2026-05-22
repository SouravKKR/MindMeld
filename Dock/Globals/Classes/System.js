const os = require('os');

class System
{
    static #lastCpuSnapshot = null;
    static #lastProcessSnapshot = null;

    static #readCpuSnapshot()
    {
        return os.cpus().map(cpu =>
        {
            const times = cpu.times;
            const totalTime = Object.values(times).reduce((a, b) => a + b, 0);
            return { idleTime: times.idle, totalTime };
        });
    }

    static getCpuUsage()
    {
        const currentSnapshot = this.#readCpuSnapshot();

        if (!this.#lastCpuSnapshot)
        {
            this.#lastCpuSnapshot = currentSnapshot;
            return 0;
        }

        let totalIdleDifference = 0;
        let totalTimeDifference = 0;

        for (let i = 0; i < currentSnapshot.length; i++)
        {
            totalIdleDifference += currentSnapshot[i].idleTime - this.#lastCpuSnapshot[i].idleTime;
            totalTimeDifference += currentSnapshot[i].totalTime - this.#lastCpuSnapshot[i].totalTime;
        }

        this.#lastCpuSnapshot = currentSnapshot;

        if (totalTimeDifference === 0)
        {
            return 0;
        }

        return 1 - (totalIdleDifference / totalTimeDifference);
    }

    static getMemoryUsage()
    {
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();

        if (totalMemory === 0)
        {
            return 0;
        }

        return (totalMemory - freeMemory) / totalMemory;
    }

    static getSystemLoadAverage()
    {
        const loadAverages = os.loadavg(); // [1min, 5min, 15min]
        const oneMinuteLoad = loadAverages[0];
        const cpuCoreCount = os.cpus().length;

        if (cpuCoreCount === 0)
        {
            return 0;
        }

        return oneMinuteLoad / cpuCoreCount;
    }

    static getProcessCpuUsage()
    {
        if (!this.#lastProcessSnapshot)
        {
            this.#lastProcessSnapshot =
            {
                cpuUsage: process.cpuUsage(),
                time: process.hrtime()
            };
            return 0;
        }

        const cpuUsageDifference = process.cpuUsage(this.#lastProcessSnapshot.cpuUsage);
        const timeDifference = process.hrtime(this.#lastProcessSnapshot.time);

        this.#lastProcessSnapshot =
        {
            cpuUsage: process.cpuUsage(),
            time: process.hrtime()
        };

        const elapsedMilliseconds = timeDifference[0] * 1000 + timeDifference[1] / 1e6;
        const cpuUsage = (cpuUsageDifference.user + cpuUsageDifference.system) / (elapsedMilliseconds * 1000);

        return Math.min(Math.max(cpuUsage, 0), 1);
    }
}

module.exports = System;