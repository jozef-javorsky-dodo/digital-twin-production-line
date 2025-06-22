declare namespace google {
    namespace visualization {
        class PieChart {
            constructor(container: HTMLElement);
            draw(data: DataTable | DataView, options?: object): void;
        }
        class LineChart {
            constructor(container: HTMLElement);
            draw(data: DataTable | DataView, options?: object): void;
        }
        class ColumnChart {
            constructor(container: HTMLElement);
            draw(data: DataTable | DataView, options?: object): void;
        }
        class DataTable {
            constructor(data?: any);
            addColumn(type: string, label?: string, id?: string): void;
            addColumn(descriptionObject: {
                type: string;
                label?: string;
                id?: string;
                role?: string;
                p?: object;
            }): void;
            addRow(cellArray?: any[]): number;
            addRows(numOrArray: number | any[][]): number;
        }
        class DataView {
            constructor(dataTable: DataTable);
        }
        function arrayToDataTable(
            twoDArray: any[],
            firstRowIsData?: boolean
        ): DataTable;
    }
    var charts: {
        load: (version: string, packages: { packages: string[] }) => void;
        setOnLoadCallback: (callback: () => void) => void;
        loaded?: boolean;
    };
}

enum MachineState {
    IDLE = "IDLE",
    PROCESSING = "PROCESSING",
    DOWN = "DOWN",
    BLOCKED_OUTPUT = "BLOCKED_OUTPUT",
}

interface ProductionItem {
    id: string;
    type: string;
    creationTime: number;
    processingHistory: {
        machineId: string;
        entryTime: number;
        exitTime: number | null;
    }[];
    currentStepStartTime: number | null;
}

interface MachineConfig {
    id: string;
    name: string;
    processTimeBaseMs: number;
    processTimeVarianceMs: number;
    failureRatePerSecond: number;
    repairTimeBaseMs: number;
    repairTimeVarianceMs: number;
    bufferCapacity: number;
}

interface MachineMetrics {
    processedItems: number;
    timeProcessingMs: number;
    timeIdleMs: number;
    timeDownMs: number;
    timeBlockedMs: number;
    currentOEE: number;
}

class Machine {
    public readonly id: string;
    public readonly name: string;
    private state: MachineState;
    private readonly processTimeBaseMs: number;
    private readonly processTimeVarianceMs: number;
    private readonly failureRatePerTick: number;
    private readonly repairTimeBaseMs: number;
    private readonly repairTimeVarianceMs: number;

    public inputBuffer: ProductionItem[];
    public readonly bufferCapacity: number;
    public currentItem: ProductionItem | null;
    private blockedItem: ProductionItem | null;

    private currentProcessTargetTimeMs: number;
    private currentRepairTargetTimeMs: number;
    private timeInCurrentStateMs: number;

    public metrics: MachineMetrics;

    private domElement: HTMLElement | null;
    private nameElement: HTMLElement | null;
    private stateElement: HTMLElement | null;
    private itemElement: HTMLElement | null;
    private bufferElement: HTMLElement | null;
    private statsElement: HTMLElement | null;

    constructor(config: MachineConfig, tickIntervalMs: number) {
        this.id = config.id;
        this.name = config.name;
        this.state = MachineState.IDLE;
        this.processTimeBaseMs = config.processTimeBaseMs;
        this.processTimeVarianceMs = config.processTimeVarianceMs;
        this.failureRatePerTick =
            (config.failureRatePerSecond * tickIntervalMs) / 1000;
        this.repairTimeBaseMs = config.repairTimeBaseMs;
        this.repairTimeVarianceMs = config.repairTimeVarianceMs;

        this.inputBuffer = [];
        this.bufferCapacity = config.bufferCapacity;
        this.currentItem = null;
        this.blockedItem = null;
        this.currentProcessTargetTimeMs = 0;
        this.currentRepairTargetTimeMs = 0;
        this.timeInCurrentStateMs = 0;

        this.metrics = {
            processedItems: 0,
            timeProcessingMs: 0,
            timeIdleMs: 0,
            timeDownMs: 0,
            timeBlockedMs: 0,
            currentOEE: 0,
        };

        this.createDomElement();
    }

    private createDomElement(): void {
        const factoryFloor = document.getElementById("factory-floor");
        if (!factoryFloor) {
            return;
        }

        this.domElement = document.createElement("div");
        this.domElement.className = `machine ${this.state.toLowerCase()}`;
        this.domElement.id = `machine-${this.id}`;

        this.nameElement = document.createElement("div");
        this.nameElement.className = "machine-name";
        this.nameElement.textContent = this.name;

        this.itemElement = document.createElement("div");
        this.itemElement.className = "product-item-display";
        this.itemElement.style.visibility = "hidden";

        this.stateElement = document.createElement("div");
        this.stateElement.className = "machine-state";

        this.bufferElement = document.createElement("div");
        this.bufferElement.className = "machine-buffer";

        this.statsElement = document.createElement("div");
        this.statsElement.className = "machine-stats";

        this.domElement.appendChild(this.nameElement);
        this.domElement.appendChild(this.itemElement);
        this.domElement.appendChild(this.stateElement);
        this.domElement.appendChild(this.bufferElement);
        this.domElement.appendChild(this.statsElement);
        factoryFloor.appendChild(this.domElement);
        this.updateDom();
    }

    public update(
        deltaTimeMs: number,
        globalTimeMs: number
    ): ProductionItem | null {
        this.timeInCurrentStateMs += deltaTimeMs;
        let newlyProcessedItem: ProductionItem | null = null;

        switch (this.state) {
            case MachineState.IDLE:
                this.metrics.timeIdleMs += deltaTimeMs;
                if (this.inputBuffer.length > 0 && !this.currentItem) {
                    this.startProcessing(globalTimeMs);
                }
                break;
            case MachineState.PROCESSING:
                this.metrics.timeProcessingMs += deltaTimeMs;
                if (this.timeInCurrentStateMs >= this.currentProcessTargetTimeMs) {
                    newlyProcessedItem = this.finishProcessing(globalTimeMs);
                } else {
                    if (Math.random() < this.failureRatePerTick) {
                        this.breakdown(globalTimeMs);
                    }
                }
                break;
            case MachineState.DOWN:
                this.metrics.timeDownMs += deltaTimeMs;
                if (this.timeInCurrentStateMs >= this.currentRepairTargetTimeMs) {
                    this.repair(globalTimeMs);
                }
                break;
            case MachineState.BLOCKED_OUTPUT:
                this.metrics.timeBlockedMs += deltaTimeMs;
                break;
        }
        this.calculateOEE();
        this.updateDom();
        return newlyProcessedItem;
    }

    private startProcessing(globalTimeMs: number): void {
        if (this.inputBuffer.length === 0 || this.currentItem) return;
        this.currentItem = this.inputBuffer.shift()!;
        if (!this.currentItem) return;

        this.currentItem.currentStepStartTime = globalTimeMs;
        const historyEntryIndex = this.currentItem.processingHistory.findIndex(
            (h) => h.machineId === this.id && h.exitTime === null
        );
        if (historyEntryIndex === -1) {
            this.currentItem.processingHistory.push({
                machineId: this.id,
                entryTime: globalTimeMs,
                exitTime: null,
            });
        } else {
            this.currentItem.processingHistory[historyEntryIndex].entryTime =
                globalTimeMs;
        }
        this.state = MachineState.PROCESSING;
        this.timeInCurrentStateMs = 0;
        this.currentProcessTargetTimeMs =
            this.processTimeBaseMs +
            Math.random() * this.processTimeVarianceMs * 2 -
            this.processTimeVarianceMs;
    }

    private finishProcessing(globalTimeMs: number): ProductionItem | null {
        const processedItem = this.currentItem;
        if (processedItem) {
            const historyEntry = processedItem.processingHistory.find(
                (h) => h.machineId === this.id && h.exitTime === null
            );
            if (historyEntry) {
                historyEntry.exitTime = globalTimeMs;
            }
        }
        this.currentItem = null;
        this.state = MachineState.IDLE;
        this.timeInCurrentStateMs = 0;
        return processedItem;
    }

    private breakdown(globalTimeMs: number): void {
        this.state = MachineState.DOWN;
        this.timeInCurrentStateMs = 0;
        this.currentRepairTargetTimeMs =
            this.repairTimeBaseMs +
            Math.random() * this.repairTimeVarianceMs * 2 -
            this.repairTimeVarianceMs;
    }

    private repair(globalTimeMs: number): void {
        this.timeInCurrentStateMs = 0;
        if (this.blockedItem) {
            this.state = MachineState.BLOCKED_OUTPUT;
        } else if (this.currentItem) {
            this.state = MachineState.PROCESSING;
        } else if (this.inputBuffer.length > 0) {
            this.startProcessing(globalTimeMs);
        } else {
            this.state = MachineState.IDLE;
        }
    }

    public tryAddItemToBuffer(item: ProductionItem): boolean {
        if (this.inputBuffer.length < this.bufferCapacity) {
            this.inputBuffer.push(item);
            this.updateDom();
            return true;
        }
        return false;
    }

    public recordItemSuccessfullyProcessed(): void {
        this.metrics.processedItems++;
    }

    public setOutputBlocked(item: ProductionItem): void {
        this.blockedItem = item;
        this.state = MachineState.BLOCKED_OUTPUT;
        this.timeInCurrentStateMs = 0;
        this.updateDom();
    }

    public clearBlockedOutput(): void {
        this.recordItemSuccessfullyProcessed();
        this.blockedItem = null;
        this.state = MachineState.IDLE;
        this.timeInCurrentStateMs = 0;
        this.updateDom();
    }

    public getBlockedItem(): ProductionItem | null {
        return this.blockedItem;
    }

    private calculateOEE(): void {
        const totalTime =
            this.metrics.timeProcessingMs +
            this.metrics.timeIdleMs +
            this.metrics.timeDownMs +
            this.metrics.timeBlockedMs;

        if (totalTime === 0) {
            this.metrics.currentOEE = 0;
            return;
        }

        const upTime =
            this.metrics.timeProcessingMs +
            this.metrics.timeIdleMs +
            this.metrics.timeBlockedMs;
        const availability = totalTime > 0 ? upTime / totalTime : 0;

        const idealCycleTime = this.processTimeBaseMs;
        const performance =
            this.metrics.timeProcessingMs > 0 && this.metrics.processedItems > 0
                ? (idealCycleTime * this.metrics.processedItems) /
                this.metrics.timeProcessingMs
                : this.metrics.timeProcessingMs === 0 &&
                    this.metrics.processedItems === 0
                    ? 1
                    : 0;
        const cappedPerformance = Math.min(1, Math.max(0, performance));

        const quality = 1;

        this.metrics.currentOEE = availability * cappedPerformance * quality;
    }

    private updateDom(): void {
        if (
            !this.domElement ||
            !this.stateElement ||
            !this.itemElement ||
            !this.bufferElement ||
            !this.statsElement
        )
            return;

        this.domElement.className = `machine ${this.state.toLowerCase()}`;
        this.stateElement.textContent = this.state;

        const itemToShow = this.currentItem || this.blockedItem;
        this.itemElement.style.visibility = itemToShow ? "visible" : "hidden";
        if (itemToShow && this.itemElement) {
            this.itemElement.textContent = itemToShow.id.slice(-2);
        }

        this.bufferElement.textContent = `Buffer: ${this.inputBuffer.length}/${this.bufferCapacity}`;
        this.statsElement.innerHTML = `Processed: ${this.metrics.processedItems
            }<br>OEE: ${(this.metrics.currentOEE * 100).toFixed(1)}%`;
    }

    public getState(): MachineState {
        return this.state;
    }
    public getMetrics(): MachineMetrics {
        return { ...this.metrics };
    }
}

class ProductionLineSimulator {
    private machines: Machine[];
    private globalTimeMs: number;
    private lastTickTimeMs: number;
    private itemCounter: number;
    private readonly tickIntervalMs: number;
    private finishedGoods: ProductionItem[];
    private animationFrameId: number | null = null;

    private machineStatusChart: google.visualization.PieChart | null = null;
    private productionOutputChart: google.visualization.LineChart | null = null;
    private processedItemsChart: google.visualization.ColumnChart | null = null;
    private machineUtilizationChart: google.visualization.ColumnChart | null =
        null;
    private chartsAreReadyToDraw: boolean = false;

    private productionHistory: { time: number; count: number }[] = [];

    constructor(machineConfigs: MachineConfig[], tickIntervalMs: number = 100) {
        this.tickIntervalMs = tickIntervalMs;
        this.machines = machineConfigs.map(
            (config) => new Machine(config, this.tickIntervalMs)
        );
        this.globalTimeMs = 0;
        this.lastTickTimeMs = performance.now();
        this.itemCounter = 0;
        this.finishedGoods = [];

        this.showApplicationContent();
        this.startSimulationLoop();
    }

    private showApplicationContent(): void {
        const loadingMessage = document.getElementById("loading-message");
        if (loadingMessage) loadingMessage.style.display = "none";

        const simContainer = document.querySelector(
            ".simulation-container"
        ) as HTMLElement;
        if (simContainer) simContainer.style.display = "block";

        const chartsContainer = document.querySelector(
            ".charts-container"
        ) as HTMLElement;
        if (chartsContainer) chartsContainer.style.display = "block";

        const errorContainer = document.getElementById("error-display-container");
        if (errorContainer) errorContainer.style.display = "none";

        requestAnimationFrame(() => {
            this.initializeCharts();
        });
    }

    private initializeCharts(): void {
        if (this.chartsAreReadyToDraw) return;

        const errorContainer = document.getElementById("error-display-container");
        try {
            const statusChartDiv = document.getElementById("machine-status-chart");
            const outputChartDiv = document.getElementById("production-output-chart");
            const itemsChartDiv = document.getElementById("processed-items-chart");
            const utilizationChartDiv = document.getElementById(
                "machine-utilization-chart"
            );

            if (
                !statusChartDiv ||
                !outputChartDiv ||
                !itemsChartDiv ||
                !utilizationChartDiv
            ) {
                if (errorContainer) {
                    errorContainer.textContent =
                        "One or more chart DOM elements not found. Charts cannot be initialized.";
                    errorContainer.style.display = "block";
                }
                return;
            }

            if (
                statusChartDiv.offsetWidth === 0 ||
                statusChartDiv.offsetHeight === 0
            ) {
                requestAnimationFrame(() => this.initializeCharts());
                return;
            }

            this.machineStatusChart = new google.visualization.PieChart(
                statusChartDiv
            );
            this.productionOutputChart = new google.visualization.LineChart(
                outputChartDiv
            );
            this.processedItemsChart = new google.visualization.ColumnChart(
                itemsChartDiv
            );
            this.machineUtilizationChart = new google.visualization.ColumnChart(
                utilizationChartDiv
            );

            this.chartsAreReadyToDraw = true;
            this.updateCharts();
        } catch (e) {
            console.error("Error creating chart instances:", e);
            if (errorContainer) {
                errorContainer.textContent =
                    "Error creating chart instances. Check console for details.";
                errorContainer.style.display = "block";
            }
        }
    }

    private generateNewItem(): ProductionItem {
        this.itemCounter++;
        return {
            id: `P${String(this.itemCounter).padStart(4, "0")}`,
            type: "Widget",
            creationTime: this.globalTimeMs,
            processingHistory: [],
            currentStepStartTime: null,
        };
    }

    private simulationStep(deltaTimeMs: number): void {
        this.globalTimeMs += deltaTimeMs;

        if (this.machines.length === 0) return;

        const firstMachine = this.machines[0];
        if (
            firstMachine.getState() === MachineState.IDLE &&
            !firstMachine.currentItem &&
            firstMachine.inputBuffer.length < firstMachine.bufferCapacity
        ) {
            if (Math.random() < 0.3) {
                const newItem = this.generateNewItem();
                firstMachine.tryAddItemToBuffer(newItem);
            }
        }

        for (let i = this.machines.length - 1; i >= 0; i--) {
            const machine = this.machines[i];

            if (machine.getState() === MachineState.BLOCKED_OUTPUT) {
                const itemToMove = machine.getBlockedItem();
                if (itemToMove) {
                    if (i < this.machines.length - 1) {
                        if (this.machines[i + 1].tryAddItemToBuffer(itemToMove)) {
                            machine.clearBlockedOutput();
                        }
                    } else {
                        this.finishedGoods.push(itemToMove);
                        machine.clearBlockedOutput();
                    }
                } else {
                    machine.clearBlockedOutput();
                }
            }

            const newlyProcessedItem = machine.update(deltaTimeMs, this.globalTimeMs);

            if (newlyProcessedItem) {
                if (i < this.machines.length - 1) {
                    if (this.machines[i + 1].tryAddItemToBuffer(newlyProcessedItem)) {
                        machine.recordItemSuccessfullyProcessed();
                    } else {
                        machine.setOutputBlocked(newlyProcessedItem);
                    }
                } else {
                    this.finishedGoods.push(newlyProcessedItem);
                    machine.recordItemSuccessfullyProcessed();
                }
            }
        }

        if (this.globalTimeMs % (this.tickIntervalMs * 10) < deltaTimeMs) {
            this.productionHistory.push({
                time: this.globalTimeMs / 1000,
                count: this.finishedGoods.length,
            });
            if (this.productionHistory.length > 100) {
                this.productionHistory.shift();
            }
        }

        if (this.globalTimeMs % (this.tickIntervalMs * 5) < deltaTimeMs) {
            if (this.chartsAreReadyToDraw) {
                this.updateCharts();
            } else {
                this.initializeCharts();
            }
        }
    }

    private simulationLoop = (): void => {
        const currentTimeMs = performance.now();
        const deltaTimeMs = currentTimeMs - this.lastTickTimeMs;

        if (deltaTimeMs >= this.tickIntervalMs) {
            this.simulationStep(this.tickIntervalMs);
            this.lastTickTimeMs = currentTimeMs - (deltaTimeMs % this.tickIntervalMs);
        }

        this.animationFrameId = requestAnimationFrame(this.simulationLoop);
    };

    public startSimulationLoop(): void {
        if (this.animationFrameId === null) {
            this.lastTickTimeMs = performance.now();
            this.simulationLoop();
        }
    }

    public stopSimulationLoop(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    private updateCharts(): void {
        if (
            !this.chartsAreReadyToDraw ||
            !this.machineStatusChart ||
            !this.productionOutputChart ||
            !this.processedItemsChart ||
            !this.machineUtilizationChart
        ) {
            return;
        }

        const chartOptionsBase = {
            backgroundColor: "transparent",
            legend: { textStyle: { color: "var(--chart-text-color)" } },
            titleTextStyle: {
                color: "var(--chart-title-color)",
                fontSize: 16,
                bold: false,
                italic: false,
            },
            hAxis: {
                textStyle: { color: "var(--chart-text-color)" },
                titleTextStyle: { color: "var(--chart-text-color)", italic: false },
            },
            vAxis: {
                textStyle: { color: "var(--chart-text-color)" },
                titleTextStyle: { color: "var(--chart-text-color)", italic: false },
                viewWindow: { min: 0 },
            },
            animation: { duration: 250, easing: "out", startup: true },
            chartArea: { left: "12%", top: "15%", width: "78%", height: "70%" },
        };

        const machineStatusData = new google.visualization.DataTable();
        machineStatusData.addColumn("string", "Status");
        machineStatusData.addColumn("number", "Count");
        const statusCounts: Record<string, number> = {
            IDLE: 0,
            PROCESSING: 0,
            DOWN: 0,
            BLOCKED_OUTPUT: 0,
        };
        this.machines.forEach(
            (m) =>
                (statusCounts[m.getState()] = (statusCounts[m.getState()] || 0) + 1)
        );
        Object.entries(statusCounts).forEach(([status, count]) => {
            machineStatusData.addRow([status, count]);
        });
        if (
            this.machines.length === 0 &&
            !Object.values(statusCounts).some((c) => c > 0)
        ) {
            machineStatusData.addRow(["No Machines", 1]);
        }
        this.machineStatusChart.draw(machineStatusData, {
            ...chartOptionsBase,
            title: "Machine Status Distribution",
            pieHole: 0.4,
            colors: ["#f0ad4e", "#5cb85c", "#d9534f", "#777777"],
        });

        const productionOutputData = new google.visualization.DataTable();
        productionOutputData.addColumn("string", "Time (s)");
        productionOutputData.addColumn("number", "Items Produced");
        if (this.productionHistory.length === 0) {
            productionOutputData.addRow(["0", 0]);
        } else {
            this.productionHistory.forEach((p) =>
                productionOutputData.addRow([p.time.toFixed(1), p.count])
            );
        }
        this.productionOutputChart.draw(productionOutputData, {
            ...chartOptionsBase,
            title: "Total Production Output Over Time",
            curveType: "function",
            legend: { position: "bottom" },
            hAxis: { ...chartOptionsBase.hAxis, title: "Time (s)" },
            vAxis: { ...chartOptionsBase.vAxis, title: "Total Items" },
        });

        const processedItemsData = new google.visualization.DataTable();
        processedItemsData.addColumn("string", "Machine");
        processedItemsData.addColumn("number", "Processed Items");
        processedItemsData.addColumn({ type: "string", role: "style" });
        const machineColors = [
            "#4285F4",
            "#DB4437",
            "#F4B400",
            "#0F9D58",
            "#AB47BC",
            "#00ACC1",
            "#FF7043",
            "#7E57C2",
        ];
        this.machines.forEach((m, idx) =>
            processedItemsData.addRow([
                m.name,
                m.getMetrics().processedItems,
                machineColors[idx % machineColors.length],
            ])
        );
        this.processedItemsChart.draw(processedItemsData, {
            ...chartOptionsBase,
            title: "Processed Items per Machine",
            legend: { position: "none" },
            hAxis: { ...chartOptionsBase.hAxis, title: "Machine" },
            vAxis: { ...chartOptionsBase.vAxis, title: "Items" },
        });

        const utilizationData = new google.visualization.DataTable();
        utilizationData.addColumn("string", "Machine");
        utilizationData.addColumn("number", "Processing");
        utilizationData.addColumn("number", "Idle");
        utilizationData.addColumn("number", "Down");
        utilizationData.addColumn("number", "Blocked");

        this.machines.forEach((m) => {
            const metrics = m.getMetrics();
            const totalTime =
                metrics.timeProcessingMs +
                metrics.timeIdleMs +
                metrics.timeDownMs +
                metrics.timeBlockedMs;
            if (totalTime > 0) {
                utilizationData.addRow([
                    m.name,
                    metrics.timeProcessingMs,
                    metrics.timeIdleMs,
                    metrics.timeDownMs,
                    metrics.timeBlockedMs,
                ]);
            } else {
                utilizationData.addRow([m.name, 0, 1, 0, 0]);
            }
        });
        this.machineUtilizationChart.draw(utilizationData, {
            ...chartOptionsBase,
            title: "Machine State Duration (%)",
            isStacked: "percent",
            legend: { position: "top", maxLines: 3 },
            hAxis: { ...chartOptionsBase.hAxis, title: "Machine" },
            series: [
                { color: "#5cb85c" },
                { color: "#f0ad4e" },
                { color: "#d9534f" },
                { color: "#777777" },
            ],
        });
    }
}

const machineConfigurations: MachineConfig[] = [
    {
        id: "M1",
        name: "Cutter",
        processTimeBaseMs: 3000,
        processTimeVarianceMs: 500,
        failureRatePerSecond: 0.02,
        repairTimeBaseMs: 5000,
        repairTimeVarianceMs: 1000,
        bufferCapacity: 3,
    },
    {
        id: "M2",
        name: "Welder",
        processTimeBaseMs: 4000,
        processTimeVarianceMs: 700,
        failureRatePerSecond: 0.03,
        repairTimeBaseMs: 6000,
        repairTimeVarianceMs: 1500,
        bufferCapacity: 3,
    },
    {
        id: "M3",
        name: "Painter",
        processTimeBaseMs: 2500,
        processTimeVarianceMs: 400,
        failureRatePerSecond: 0.015,
        repairTimeBaseMs: 4000,
        repairTimeVarianceMs: 800,
        bufferCapacity: 3,
    },
    {
        id: "M4",
        name: "Assembler",
        processTimeBaseMs: 5000,
        processTimeVarianceMs: 1000,
        failureRatePerSecond: 0.025,
        repairTimeBaseMs: 7000,
        repairTimeVarianceMs: 2000,
        bufferCapacity: 3,
    },
    {
        id: "M5",
        name: "QA Check",
        processTimeBaseMs: 2000,
        processTimeVarianceMs: 300,
        failureRatePerSecond: 0.01,
        repairTimeBaseMs: 3000,
        repairTimeVarianceMs: 500,
        bufferCapacity: 2,
    },
];

new ProductionLineSimulator(machineConfigurations, 100);