import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import * as WebSocket from "ws";
import * as http from "http";
import {ServerSocketPublisher, ServerSocket, ClientSocketOnServer} from "./ServerSocket";
import {AppPublisher} from "./AppPublisher";
import {WebSocketOpcode} from "./opcodes";
import TradeAdvisor from "../TradeAdvisor";
import {AbstractAdvisor} from "../AbstractAdvisor";
import {ConfigEditor} from "./ConfigEditor";
import {TradeConfig} from "../Trade/TradeConfig";
import * as path from "path";
import * as fs from "fs";
import * as childProcess from "child_process";
import {BotEvaluation} from "../Trade/PortfolioTrader";
import {currencyImportMap, liveTradeImportMap, MultipleCurrencyImportExchange} from "../../configLocal";
import {Currency} from "@ekliptor/bit-models";
const fork = childProcess.fork;
import * as Heap from "qheap";

const processFiles = [path.join(utils.appDir, 'app.js'),
    path.join(utils.appDir, 'build', 'app.js')]
const processFile = fs.existsSync(processFiles[0]) ? processFiles[0] : processFiles[1]

export interface BacktestInitData {
    fromDays: number;
    toDays: number;
    lastFromMs: number;
    lastToMs: number;
    configFiles: string[];
    exchanges: string[];
    selectedConfig: string;
    startBalance: number;
    currencyImportMap: {
        //[exchangeName: string]: Currency.CurrencyPair[];
        [exchangeName: string]: string[]; // currency pairs converted to string
    }
    recentBacktests: string[];
}
export interface BacktestResult {
    file: string;
    stats: BotEvaluation;
    baseCurrency: string;
    quoteCurrency: string;
}

export interface BacktestReq {
    start?: {
        config: string;
        exchange: string;
        from: number; // ms
        to: number;
        startBalance: number;
        slippage: number;
        tradingFee: number;
    }
}
export interface BacktestRes {
    error?: boolean;
    errorTxt?: string;
    errorCode?: string;
    success?: boolean; // shows message as success (green). same strings as error

    init?: BacktestInitData;
    result?: BacktestResult;
    progress?: {
        current: number; // ms
        end: number;
        percent: number;
    }
    importProgress?: {
        percent: number;
    }
}

class BacktestingFileStat {
    public readonly name: string;
    public readonly ctimeMs: number;
    constructor(name: string, ctime: number) {
        this.name = name;
        this.ctimeMs = ctime;
    }
}

export class BacktestingUpdater extends AppPublisher {
    public readonly opcode = WebSocketOpcode.BACKTESTING;
    protected selectedConfig: string;
    protected lastBacktestingConfig: string = "";
    protected lastBacktestBalance: number = 1.0;
    protected backtestRunning = false;
    //protected backtestingSockets = new Map<string, WebSocket>(); // (socket id, socket) // to resume showing progress
    protected lastBacktestFromMs: number = 0;
    protected lastBacktestToMs: number = 0;
    protected recentBacktests: string[] = []; // array of file names

    constructor(serverSocket: ServerSocket, advisor: AbstractAdvisor) {
        super(serverSocket, advisor)
        this.selectedConfig = this.advisor.getConfigName();
    }

    public onSubscription(clientSocket: ClientSocketOnServer, initialRequest: http.IncomingMessage): void {
        //this.backtestingSockets.set((clientSocket as any).id, clientSocket)
        ConfigEditor.listConfigFiles("trading").then(async (configFiles) => {
            let update: BacktestRes = {
                init: {
                    fromDays: nconf.get("data:backtestStartAgoDays"),
                    toDays: nconf.get("data:backtestEndAgoDays"),
                    lastFromMs: this.lastBacktestFromMs,
                    lastToMs: this.lastBacktestToMs,
                    configFiles: configFiles,
                    exchanges: this.getBacktestExchanges(),
                    selectedConfig: this.lastBacktestingConfig ? this.lastBacktestingConfig : this.selectedConfig,
                    startBalance: this.lastBacktestBalance,
                    currencyImportMap: this.getCurrencyPairImportMap(),
                    recentBacktests: await this.getRecentBacktests()
                }
            }
            this.send(clientSocket, update)
            //if (this.backtestRunning === false)
                //return;
            // we never unsubscribe and just send messages until the backtest is done
        })
    }

    /*
    public onClose(clientSocket: ClientSocketOnServer): void {
        this.backtestingSockets.delete((clientSocket as any).id)
    }
    */

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected onData(data: BacktestReq, clientSocket: ClientSocketOnServer, initialRequest: http.IncomingMessage): void {
        if (data.start)
            this.startBacktest(data, clientSocket);
    }

    protected async startBacktest(data: BacktestReq, clientSocket: ClientSocketOnServer) {
        let update: BacktestRes = {};
        if (nconf.get("serverConfig:premium") === true && nconf.get("serverConfig:loggedIn") === false) {
            logger.error("You need a valid subscription to start backtesting");
            update.error = true;
            update.errorCode = "backetestSubsRequired";
            this.send(clientSocket, update)
        }
        if (this.backtestRunning === true)
            return;
        this.backtestRunning = true;
        this.recentBacktests = []; // invalidate cache, not really needed here

        let filePath = path.join(TradeConfig.getConfigDirForMode("trading"), data.start.config);
        let backtestFilePath: string;
        try {
            let fileText = await utils.file.readFile(filePath);
            let json = utils.parseJson(fileText);
            if (!json || !json.data) {
                logger.error("Invalid JSON in config file: %s", filePath)
                update.error = true;
                update.errorCode = "invalidConfig";
                this.backtestRunning = false;
                this.send(clientSocket, update)
                return
            }
            else if (Array.isArray(json.data) === false || json.data.length !== 1) { // child process truncates to only use the 1st pair
                /*
                logger.error("Config for backtesting must contian exactly 1 trading pair: %s", path.basename(filePath))
                update.error = true;
                update.errorCode = "exchangeMismatch";
                this.backtestRunning = false;
                this.send(clientSocket, update)
                return;
                 */
                logger.warn("Config for backtesting contains multiple trading pairs/exchange. Only backtesting 1st: %s", path.basename(filePath))
            }
            // we could also just rename the exchange temporarily in the file (exchanges are only loaded on startup for live trading)
            // but this more clean
            backtestFilePath = filePath.replace(/\.json$/, "-bt.json");
            json.data[0].exchanges = [data.start.exchange];
            //if (await utils.file.copyFile(filePath, backtestFilePath, true) === false) // better write it after setting the exchange
                //throw new Error("Error copying backtest config file to" + backtestFilePath);
            await fs.promises.writeFile(backtestFilePath, utils.stringifyBeautiful(json), {encoding: "utf8"});
            const backtestConfigName = data.start.config.replace(/\.json$/, "-bt.json");
            let tradeConfig = new TradeConfig(json.data[0], backtestFilePath)
            await this.forkBacktestProcess(backtestConfigName, tradeConfig, data);
        }
        catch (err) {
            logger.error("Error during backtest", err);
            update.error = true;
            update.errorCode = "backetestError";
            this.send(clientSocket, update)
        }
        this.backtestRunning = false;
        if (backtestFilePath)
            utils.file.deleteFiles([backtestFilePath]);
    }

    protected forkBacktestProcess(configFilename: string, tradeConfig: TradeConfig, data: BacktestReq) {
        return new Promise<void>((resolve, reject) => {
            //this.runningBacktestInstances++;
            let processArgs = Object.assign([], process.execArgv)
            let dbg = false
            for (let i=0; i < processArgs.length; i++) {
                if (processArgs[i].substr(0,12) == "--debug-brk=") {
                    processArgs[i] = "--debug-brk=" + (nconf.get('debuggerPort') ? nconf.get('debuggerPort') : 43207)
                    dbg = true
                    //break
                }
            }
            let nodeArgs = process.argv.slice(2)
            nodeArgs = utils.proc.addChildProcessArgument(nodeArgs, "--trader", "Backtester")
            let childConfig = path.basename(configFilename, ".json");
            this.lastBacktestingConfig = childConfig;
            logger.info("Starting backtest for config %s", childConfig);
            nodeArgs = utils.proc.addChildProcessArgument(nodeArgs, "--config", childConfig)
            let env = Object.assign({}, process.env)
            if (nodeArgs.indexOf("--child") === -1)
                nodeArgs.push("--child") // for easy filtering with grep command
            env.IS_CHILD = true
            env.PARENT_PROCESS_ID = process.pid;
            env.EXCHANGE = data.start.exchange;
            env.START_TIME_MS = data.start.from; // TODO pack data into a message and send it via JSON
            env.END_TIME_MS = data.start.to;
            this.lastBacktestFromMs = data.start.from;
            this.lastBacktestToMs = data.start.to;
            env.START_BALANCE = data.start.startBalance;
            this.lastBacktestBalance = data.start.startBalance;
            env.SLIPPAGE = data.start.slippage;
            env.TRADING_FEE = data.start.tradingFee;
            let options = {
                cwd: process.cwd(),
                env: env,
                execPath: process.execPath,
                execArgv: processArgs, // don't change anything on the process arguments. process get's restarted with same args below
                silent: false
                //stdio:
            }
            let child = fork(processFile, nodeArgs, options)
            let gotResults = false
            child.on('error', (err) => {
                reject(err)
            })
            utils.winstonChildProc.addChildListener(logger, child);
            child.on('exit', (code, signal) => {
                logger.info('Backtest process exited with code %s - signal %s', code, signal)
                child = null
                if (gotResults)
                    resolve()
                else
                    reject('Backtest process exited without sending results')
                //this.onBacktestDone()
            })
            child.on('message', (message) => {
                this.onChildMessage(configFilename, tradeConfig, message, data)
                if (message.type === 'result')
                    gotResults = true
            })
            //child.unref(); // see also options.detached (default false, only for spawn?). but we kill the child explicitly on exit and don't wait for it

            if (dbg)
                debugger
            /* // child process starts immediately (bad for debugging, but we can debug it separately)
             child.send({
             updateStatsClassName: "foo",
             type: 'start'
             })
             */
        })
    }

    protected onChildMessage(configFilename: string, tradeConfig: TradeConfig, message: any, data: BacktestReq) {
        switch (message.type)
        {
            case 'result':
                let result: BotEvaluation = message.result;
                logger.info('Received backtest results from child: bot %s%, market %s%', result.botEfficiencyPercent, result.marketEfficiencyPercent)
                //this.results.insert({result: result, output: path.basename(configFilename, ".json"), params: tradeConfig})
                //this.resultsMap.set(configFilename, result)
                let finalTickUpdate: BacktestRes = {
                    progress: {
                        current: data.start.to,
                        end: data.start.to,
                        percent: 100.0
                    }
                }
                //this.send(clientSocket, finalTickUpdate)
                this.publish(finalTickUpdate)
                let replaceRegex = new RegExp("^" + utils.escapeRegex(path.join(utils.appDir, nconf.get("tradesDir"))))
                let relativeFilePath = message.file.replace(replaceRegex, "");
                if (relativeFilePath[0] === path.sep)
                    relativeFilePath = relativeFilePath.substr(1);
                const currencyPairStr = tradeConfig.markets[0].toString();
                const currencyParts = currencyPairStr.split("_");
                let resultUpdate: BacktestRes = {
                    result: {
                        file: relativeFilePath,
                        stats: result,
                        baseCurrency: currencyParts[0],
                        quoteCurrency: currencyParts[1]
                    }
                }
                this.publish(resultUpdate)
                this.recentBacktests = []; // invalidate cache
                break;
            case 'tick':
                let tickUpdate: BacktestRes = {
                    progress: {
                        current: message.data.timeMs,
                        end: data.start.to,
                        percent: 0
                    }
                }
                const range = tickUpdate.progress.end - data.start.from;
                tickUpdate.progress.percent = Math.floor((tickUpdate.progress.current - data.start.from) / range * 100.0 * 100) / 100.0;
                while (tickUpdate.progress.percent > 100.0) // TODO why does it get over 100% when crossing a year?
                    tickUpdate.progress.percent -= 100.0;
                this.publish(tickUpdate)/*.then((success) => {
                    if (success === false)
                })*/
                break;
            case 'startImport':
                logger.info("Start importing trade history of %s", message.exchange)
                let startUpdate: BacktestRes = {
                    success: true,
                    errorCode: "startAutoImport"
                }
                this.publish(startUpdate)
                break;
            case 'profitPartialWarning':
                let strategyWarning: BacktestRes = {
                    success: false,
                    errorCode: "profitPartialWarningMsg"
                }
                this.publish(startUpdate)
                break;
            case 'importTick':
                let importUpdate: BacktestRes = {
                    importProgress: {
                        percent: message.data.percent
                    }
                }
                this.publish(importUpdate)
                break;
            case 'autoImportNotSupported': {
                let strategyWarning: BacktestRes = {
                    success: false,
                    errorCode: "autoImportOtherExchange"
                }
                this.publish(strategyWarning)
                break;
            }
            case 'errorImport':
                logger.error("Error importing trade history of %s", message.exchange)
                let update: BacktestRes = {
                    error: true,
                    errorCode: "errorAutoImport"
                }
                this.publish(update)
                break;
            case 'error':
                logger.error('Backtest child process error', message.error)
                let errorUpdate: BacktestRes = {
                    error: true
                }
                this.publish(errorUpdate)
                break;
            default:
                if (message.type === undefined && message.cmd && message.cmd === 'log')
                    break; // child process logs
                logger.warn('Received unknown backtest child message of type: %s', message.type)
        }
    }

    protected getCurrencyPairImportMap() {
        let map = new Map<string, string[]>();
        // merge both. duplicates with have the value of the last key
        const availableImports = new Map<MultipleCurrencyImportExchange, Currency.CurrencyPair[]>([...currencyImportMap, ...liveTradeImportMap]);
        for (let cur of availableImports)
        {
            const exchange = cur[0];
            const pairs = cur[1];
            let strPairs = [];
            for (let i = 0; i < pairs.length; i++)
                strPairs.push(pairs[i].toString());
            map.set(exchange, strPairs);
        }
        return map.toObject();
    }

    protected getBacktestExchanges() {
        let exchanges = Array.from(Currency.ExchangeName.keys());
        if (nconf.get("serverConfig:premium") === false)
            return exchanges;
        let backtestExchanges = exchanges.filter((e: MultipleCurrencyImportExchange) => {
            return currencyImportMap.has(e) || liveTradeImportMap.has(e);
        });
        return backtestExchanges;
    }

    protected getLogPath() {
        return path.join(utils.appDir, nconf.get("tradesDir")); // backfindDir is a subdir, see PortfolioTrader constructor
    }

    protected async getRecentBacktests(): Promise<string[]> {
        if (this.recentBacktests.length !== 0)
            return this.recentBacktests; // use cached
        try {
            let files = await fs.promises.readdir(this.getLogPath(), {encoding: "utf8"});
            this.recentBacktests = await this.getMostRecentFiles(files.filter(f => /\.html$/i.test(f) === true));
            return this.recentBacktests;
        }
        catch (err) {
            logger.error("Error getting recent backtests", err);
            return [];
        }
    }

    protected async getMostRecentFiles(files: string[]): Promise<string[]> {
        let recentBacktests = new Heap({
            comparBefore(a: BacktestingFileStat, b: BacktestingFileStat) {
                return a.ctimeMs > b.ctimeMs; // higher numbers (newer files) come first
            },
            compar(a: BacktestingFileStat, b: BacktestingFileStat) {
                return a.ctimeMs > b.ctimeMs ? -1 : 1;
            },
            freeSpace: true,
            size: 40
        });
        for (let i = 0; i < files.length; i++)
        {
            const filePath = path.join(this.getLogPath(), files[i]);
            try {
                let stats = await fs.promises.stat(filePath);
                let backtestFile = new BacktestingFileStat(files[i], stats.ctimeMs);
                recentBacktests.insert(backtestFile);
            }
            catch (err) {
                logger.error("Error getting file stats of %s", filePath, err);
            }
        }
        const limit = nconf.get("serverConfig:showRecentTestCount");
        let orderedResult = [];
        for (let i = 0; i < limit; i++)
        {
            let next = recentBacktests.remove();
            if (next === undefined)
                break;
            orderedResult.push(next.name);
        }

        // delete old backtests
        if (nconf.get("serverConfig:premium") === true) {
            let next, removeFiles = [];
            while ((next = recentBacktests.remove()) !== undefined)
            {
                const nextPath = path.join(this.getLogPath(), next.name);
                removeFiles.push(nextPath);
            }
            try {
                await utils.file.deleteFiles(removeFiles);
            }
            catch (err) {
                logger.error("Error deleting old backtest files", err);
            }
        }
        return orderedResult;
    }
}
