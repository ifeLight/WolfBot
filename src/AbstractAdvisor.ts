import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import {AbstractSubController} from "./AbstractSubController";
import {Currency, Trade, Candle, Order, Funding, serverConfig} from "@ekliptor/bit-models";
import * as db from "./database";
import {AbstractExchange, ExchangeMap} from "./Exchanges/AbstractExchange";
import {default as HistoryDataExchange, HistoryExchangeMap, HistoryDataExchangeOptions} from "./Exchanges/HistoryDataExchange";
import {AbstractGenericTrader} from "./Trade/AbstractGenericTrader";
import {ConfigCurrencyPair, TradeConfig} from "./Trade/TradeConfig";
import {LendingConfig} from "./Lending/LendingConfig";
import {LendingExchangeMap} from "./Exchanges/AbstractLendingExchange";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {SocialConfig} from "./Social/SocialConfig";
import {AbstractConfig} from "./Trade/AbstractConfig";
import {CurrencyCandleBatcherMap} from "./TradeAdvisor";
import {CandleMaker} from "./Trade/Candles/CandleMaker";
import {TradeBook} from "./Trade/TradeBook";
import ExchangeController from "./ExchangeController";
import {AbstractGenericStrategy} from "./Strategies/AbstractGenericStrategy";
import * as childProcess from "child_process";
import Notification from "./Notifications/Notification";
import {AbstractNotification} from "./Notifications/AbstractNotification";
import {CandleBatcher} from "./Trade/Candles/CandleBatcher";
import {liveTradeImportMap, MultipleCurrencyImportExchange} from "../configLocal";
const fork = childProcess.fork;

const processFiles = [path.join(utils.appDir, 'app.js'),
    path.join(utils.appDir, 'build', 'app.js')]
const processFile = fs.existsSync(processFiles[0]) ? processFiles[0] : processFiles[1]


export interface StrategyJson {
    [strategyName: string]: any;
}
class DummyGenericStrategyMap extends Map<ConfigCurrencyPair, any[]> { // different in base classes
    constructor() {
        super()
    }
}
export class RestoryStrategyStateMap extends Map<number, any> { // (candle size, strategy data)
    constructor() {
        super()
    }
    public add(state: any) {
        // we only keep the longest state with most candles of this candle size
        let existingState = this.get(state.runningCandleSize);
        if (existingState) {
            if (existingState.candleHistory && state.candleHistory && existingState.candleHistory.length < state.candleHistory.length)
                this.set(state.runningCandleSize, state);
            return;
        }
        this.set(state.runningCandleSize, state);
    }
}

export class PendingBacktest {
    public currencyPair: Currency.CurrencyPair;
    public minutes: number;
    public strategies: AbstractGenericStrategy[];
    public endMs = 0; // set once the backtest starts
    constructor(currencyPair: Currency.CurrencyPair, minutes: number, strategies: AbstractGenericStrategy[]) {
        this.currencyPair = currencyPair;
        this.minutes = minutes;
        this.strategies = strategies;
    }
}

export enum BacktestWarmupState {
    IDLE = 0,
    IMPORTING = 1,
    IMPORT_FAILED = 2, // changed to IDLE by timer
    BACKTEST_DONE = 3, // changed to IDLE by timer
    BACKTEST_FAILED = 4, // changed to IDLE by timer
    BACKTESTING = 5
}

export abstract class AbstractAdvisor extends AbstractSubController {
    protected readonly started = new Date();
    protected exchangeController: ExchangeController;
    protected candleCurrencies: string[] = [];
    protected strategies: DummyGenericStrategyMap = new DummyGenericStrategyMap();
    protected candleMakers: Map<any, any>; // types specified in subclasses
    protected candleBatchers: Map<any, any>;
    protected tradeBook: TradeBook;
    protected loadedConfig = false;
    protected delayTradeUpdatesMs: number = 0;
    protected previousCpuUsage: NodeJS.CpuUsage = null;
    protected pendingBacktests: PendingBacktest[] = [];
    protected backtestRunning = false;
    protected backtestWarmupState: BacktestWarmupState = BacktestWarmupState.IDLE;
    protected notifier: AbstractNotification;

    protected errorState = false;

    constructor() {
        super()
        this.notifier = AbstractNotification.getInstance();
    }

    public getStarted() {
        return this.started;
    }

    public abstract getExchanges(): ExchangeMap | LendingExchangeMap;

    // complicated to iterate over lists of strategies with different types. use 2 different functions instead
    //public abstract getStrategies(): StrategyMap | LendingStrategyMap;

    /**
     * Returns the current config file name without the .json ending.
     */
    public abstract getConfigName(): string;

    //public abstract getConfigs(): TradeConfig[] | LendingConfig[];
    public abstract getConfigs(): (TradeConfig | LendingConfig | SocialConfig)[];

    public static getConfigByNr<T extends AbstractConfig>(configs: T[], configNr: number): T {
        let low = Number.MAX_VALUE;
        for (let i = 0; i < configs.length; i++)
        {
            if (configs[i].configNr < low)
                low = configs[i].configNr;
            if (configs[i].configNr === configNr)
                return configs[i];
        }
        logger.error("Unable to find config nr %s in array of %s configs, lowest nr %s", configNr, configs.length, low)
        return null;
    }

    public getTraderName(forDisplay = false): string {
        if (!forDisplay || this.getTraders().length !== 0) {
            if (nconf.get("lending"))
                return nconf.get("trader").replace("Trader", "LendingTrader");
            return nconf.get("trader");
        }
        return "-";
    }

    public abstract getTraders(): AbstractGenericTrader[];

    public getExchangeController() {
        return this.exchangeController;
    }

    //public abstract getCandleMaker(currencyPair: string, exchangeLabel?: Currency.Exchange): (CandleMaker<Trade.Trade> | CandleMaker<Funding.FundingTrade>);
    public getCandleMaker(currencyPair: string, exchangeLabel?: Currency.Exchange): (CandleMaker<Trade.Trade> | CandleMaker<Funding.FundingTrade>) {
        if (nconf.get("arbitrage")) {
            if (!exchangeLabel) {
                logger.error("exchange label must be provided to get candle batchers in arbitrage mode")
                return null;
            }
            const batcherKey = Currency.Exchange[exchangeLabel] + "-" + currencyPair;
            return this.candleMakers.get(batcherKey);
        }
        return this.candleMakers.get(currencyPair);
    }

    //public abstract getCandleBatchers(currencyPair: string, exchangeLabel?: Currency.Exchange): (CurrencyCandleBatcherMap<Trade.Trade> | CurrencyCandleBatcherMap<Funding.FundingTrade>);
    public getCandleBatchers(currencyPair: string, exchangeLabel?: Currency.Exchange): (CurrencyCandleBatcherMap<Trade.Trade> | CurrencyCandleBatcherMap<Funding.FundingTrade>) {
        if (nconf.get("arbitrage")) {
            if (!exchangeLabel) {
                logger.error("exchange label must be provided to get candle batchers in arbitrage mode")
                return null;
            }
            const batcherKey = Currency.Exchange[exchangeLabel] + "-" + currencyPair;
            return this.candleBatchers.get(batcherKey);
        }
        return this.candleBatchers.get(currencyPair);
    }

    public getCandleCurrencies() {
        return this.candleCurrencies;
    }

    public getTradeBook() {
        return this.tradeBook;
    }

    public serializeAllStrategyData() {
        let state = {}
        for (let strat of this.strategies)
        {
            let data = {}
            let configCurrencyPair = strat[0];
            let strategies = strat[1];
            for (let i = 0; i < strategies.length; i++)
            {
                if (strategies[i].getSaveState()) {
                    data[strategies[i].getClassName()] = strategies[i].serialize();
                }
            }
            state[configCurrencyPair] = data;
        }
        return state;
    }

    public serializeStrategyData(pair: ConfigCurrencyPair) {
        let strategies = this.strategies.get(pair);
        let data = {}
        for (let i = 0; i < strategies.length; i++)
        {
            if (strategies[i].getSaveState())
                data[strategies[i].getClassName()] = strategies[i].serialize();
        }
        return data;
    }

    public abstract unserializeStrategyData(json: any, filePath: string): boolean;

    public getSaveStateFile() {
        return path.join(utils.appDir, "temp", "state-" + this.getConfigName() + ".json")
    }

    public getSaveStateBackupFile() {
        return path.join(utils.appDir, "temp", "state-" + this.getConfigName() + "-bak.json")
    }

    public getSavePortfolioFile() {
        return path.join(utils.appDir, "temp", "portfolio-" + this.getConfigName() + ".json")
    }

    public getBacktestWarmupState() {
        return this.backtestWarmupState;
    }

    public isErrorState() {
        return this.errorState;
    }

    /**
     * Backup config files
     * @param overwriteFiles An array of file names (with or the .json ending) to allow overwriting existing backups.
     */
    public static backupOriginalConfig(overwriteFiles: string[] = []) {
        return new Promise<void>((resolve, reject) => {
            // simple way: backup every config file once (don't overwrite). this includes user config files
            for (let i = 0; i < overwriteFiles.length; i++) {
                if (overwriteFiles[i][0] === path.sep)
                    overwriteFiles[i] = overwriteFiles[i].substr(1);
                if (overwriteFiles[i].substr(-5) !== ".json")
                    overwriteFiles[i] += ".json";
            }
            if (nconf.get("trader") === "Backtester" || process.env.IS_CHILD)
                return resolve(); // no need to always back it up in backtesting mode
            const configDir = TradeConfig.getConfigRootDir();
            const backupDir = TradeConfig.getConfigBackupRootDir();
            utils.file.listDir(configDir, async (err, files) => {
                if (err) {
                    logger.error("Error reading config dir to backup", err);
                    return resolve();
                }
                let fileOps = [];
                await utils.file.ensureDir(backupDir);
                files.forEach((file) => {
                    let fullSrcPath = path.join(configDir, file);
                    let fullDestPath = path.join(backupDir, file);
                    let fileShort = file;
                    if (file[0] === path.sep)
                        fileShort = file.substr(1);
                    const overwrite = overwriteFiles.indexOf(fileShort) !== -1;
                    fileOps.push(utils.file.copyFile(fullSrcPath, fullDestPath, overwrite)); // adds new config files without overwriting existing ones
                });
                try {
                    logger.verbose("Creating backup of %s config files", fileOps.length)
                    await fileOps;
                }
                catch (err) {
                    logger.error("Error backing up config files", err)
                }
                resolve();
            });
        })
    }

    public process() {
        return new Promise<void>((resolve, reject) => {
            if (this.skipLoadingConfig() === true)
                return resolve();
            if (this.loadedConfig === false) {
                //return setTimeout(this.process.bind(this), 100); // creates a new stack. first promise doesn't get resolved
                let checkConfigLoaded = () => {
                    setTimeout(async () => {
                        if (this.loadedConfig === false)
                            return checkConfigLoaded();
                        resolve();
                    }, 100);
                }
                checkConfigLoaded();
                return
            }
            // our trades come from MarketStreams: no stream data -> no price changes
            if (!this.errorState)
                resolve()
        })
    }

    public static liveTradeImportsAvailable(exchangeName: string, currencyPair: Currency.CurrencyPair): boolean {
        const exchangePairs = liveTradeImportMap.get(exchangeName as MultipleCurrencyImportExchange);
        if (exchangePairs === undefined)
            return false;
        for (let i = 0; i < exchangePairs.length; i++)
        {
            if (exchangePairs[i].equals(currencyPair) === true)
                return true;
        }
        return false;
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected restoreState() {
        if (nconf.get("debug") && (os.platform() === 'darwin' || os.platform() === 'win32')) {
            logger.verbose("Skipped restoring config state in debug mode")
            return
        }
        const filePath = fs.existsSync(this.getSaveStateFile()) ? this.getSaveStateFile() : this.getSaveStateBackupFile();
        fs.readFile(filePath, {encoding: "utf8"}, (err, data) => {
            if (err) {
                if (err.code === 'ENOENT')
                    logger.info("No state to restore has been saved for current config")
                else
                    logger.error("Error reading file to restore state: %s", filePath, err)
                this.createAllStatesFromBacktest();
                return;
            }

            fs.stat(filePath, (err, stats) => {
                if (err) {
                    logger.error("Error getting stats of file to restore state: %s", filePath, err)
                    this.createAllStatesFromBacktest();
                    return;
                }
                const modifiedExpirationMs = stats.mtime.getTime() + nconf.get("serverConfig:restoreStateMaxAgeMin")*utils.constants.MINUTE_IN_SECONDS*1000;
                if (modifiedExpirationMs < Date.now()) {
                    logger.warn("Skipped restoring strategy state because the file is too old")
                    this.createAllStatesFromBacktest();
                    return;
                }

                let unpackState = utils.text.isPossibleJson(data) ? Promise.resolve(data) : utils.text.unpackGzip(data)
                unpackState.then((unpackedStr) => {
                    let state = utils.parseEJson(unpackedStr)
                    if (state)
                        this.unserializeStrategyData(state, filePath)

                    /* // just don't delete it. it will get overwritten
                    setTimeout(() => { // delete the state later in case the bot crashes on startup
                        utils.file.deleteFiles([filePath]).then(() => {
                        }).catch((err) => {
                            logger.error("Error deleting restored state files from disk", err)
                        })
                    }, nconf.get("serverConfig:saveStateMin")/2*utils.constants.MINUTE_IN_SECONDS*1000)
                    */
                }).catch((err) => {
                    logger.error("Error unpacking state string", err)
                })
            })
        })
    }

    protected createAllStatesFromBacktest() {
        if (!nconf.get("serverConfig:restoreStateFromBacktest"))
            return;
        logger.warn("Restoring strategy states from backtest is only supported in trading mode");
    }

    protected skipLoadingConfig() {
        if (nconf.get("ai"))
            return true; // BudFox manages the markets for AI. we just need few variables from here for status & logging
        else if (nconf.get("lending") || nconf.get("social"))
            return true; // we have our own lending/social controller
        return false;
    }

    protected waitForRestart() {
        this.errorState = true;
        //process.exit(1) // don't exit or else we can't restart it via http API
        logger.error("App entered error state. Please restart the app")
    }

    protected getMaxWarmupMinutes(strategies: AbstractGenericStrategy[]) {
        let warmupMinutes = strategies.filter(s => s.getAction().candleSize != 0).map(s => s.getMinWarumCandles() * s.getAction().candleSize);
        warmupMinutes.push(1);
        return Math.max(...warmupMinutes);
    }

    protected handleDynamicTradeDelay(lastSentDate: Date, forwardTradesMs: number, tradeCount: number) {
        if (/*this.getExchanges().size < 3*/this.getConfigs().length < 3)
            return; // should be handled by CPU
        // TODO implement delayTradeUpdatesMs as a map per currency pair as sometimes just 1 exchange is slow
        const delayMs = Date.now() - lastSentDate.getTime() - forwardTradesMs; // delayTradeUpdatesMs already included
        if (delayMs > nconf.get("serverConfig:delayIgnoreIncresseMs"))
            return;
        const maxDelayMs = nconf.get("serverConfig:maxDelayedTradesMs");
        const upperLimitMs = nconf.get("serverConfig:upperLimitDelayMs");

        // if our CPU was too busy in userspace we increase our dynamic delay
        this.previousCpuUsage = process.cpuUsage(this.previousCpuUsage ? this.previousCpuUsage : undefined);
        const userDelayMs = this.previousCpuUsage.user / 1000; // from microseconds
        if (delayMs > maxDelayMs && userDelayMs > 2.5*delayMs && tradeCount >= nconf.get("serverConfig:minTradeCountForIncrease") && this.delayTradeUpdatesMs < upperLimitMs) {
            this.delayTradeUpdatesMs += nconf.get("serverConfig:increaseTradeDynamicSec")*1000;
            if (this.delayTradeUpdatesMs > upperLimitMs)
                this.delayTradeUpdatesMs = upperLimitMs;
            logger.warn("Increasing trade forward frequency by %s sec to %s ms (high CPU) delay %s ms, trade count %s, userspace CPU %s ms",
                nconf.get("serverConfig:increaseTradeDynamicSec"), this.delayTradeUpdatesMs, delayMs, tradeCount, Math.floor(userDelayMs));
        }
        else if (delayMs <= maxDelayMs && this.delayTradeUpdatesMs > 0) {
            const reduceMs = Math.ceil(nconf.get("serverConfig:increaseTradeDynamicSec")*1000/4);
            //logger.verbose("Reducing trade forward frequency becuase CPU load is OK by %s ms back to %s ms", reduceMs, forwardTradesMs-reduceMs);
            this.delayTradeUpdatesMs = Math.max(0, this.delayTradeUpdatesMs - reduceMs);
        }
    }

    /**
     * Return the strategy with the most 1min candles.
     * @param strategies
     */
    protected getMaxCandleHistoryStrategy(strategies: AbstractGenericStrategy[]) {
        let maxStrategy: AbstractGenericStrategy = null;
        for (let i = 0; i < strategies.length; i++)
        {
            if (maxStrategy === null)
                maxStrategy = strategies[i];
            else if (strategies[i].getCandles1Min().length > maxStrategy.getCandles1Min().length)
                maxStrategy = strategies[i];
        }
        return maxStrategy;
    }

    /**
     * Starts a backtest for the purpose of importing trades history on startup (only if no data has been saved).
     * See Backtester for actual backtests where we are interested in the results.
     */
    protected async startBacktest(): Promise<void> {
        if (this.pendingBacktests.length === 0) {
            this.backtestRunning = false;
            return;
        }
        this.backtestRunning = true;
        const nextBacktest = this.pendingBacktests.shift();
        try {
            const filePath = path.join(TradeConfig.getConfigDir(), this.getConfigName() + ".json");
            let data = await utils.file.readFile(filePath)
            let json = utils.parseJson(data);
            if (!json || Array.isArray(json.data) === false)
                throw new Error("Invalid config json to run backtest: " + filePath);
            for (let i = 0; i < json.data.length; i++)
            {
                let conf = json.data[i];
                if (!this.matchByStrategies(conf, nextBacktest))
                    continue;

                logger.verbose("Starting import-backtest for %s", nextBacktest.currencyPair.toString())
                const tempFilePath = filePath.replace(/\.json$/, "-temp.json");
                await this.writeBacktestTempConfig(tempFilePath, conf);
                let config = new TradeConfig(conf, this.getConfigName());
                this.forkBacktestProcess(tempFilePath, config, nextBacktest).catch((err) => {
                    logger.error("Error during import-backtest", err)
                }).then(() => {
                    setTimeout(() => { // delay it to be sure we can always read from it
                        utils.file.deleteFiles([tempFilePath])
                    }, 5000);
                    setTimeout(this.startBacktest.bind(this), 0);
                })
                break;
            }
        }
        catch (err) {
            logger.error("Error starting backtest for %s", nextBacktest.currencyPair, err)
            setTimeout(this.startBacktest.bind(this), 0);
        }
    }

    protected writeBacktestTempConfig(configPath: string, confData: any) {
        return new Promise<void>((resolve, reject) => {
            const dataStr = utils.stringifyBeautiful({
                data: [confData]
            });
            fs.writeFile(configPath, dataStr, {encoding: "utf8"}, (err) => {
                if (err)
                    return reject(err);
                resolve()
            })
        })
    }

    protected matchByStrategies(jsonConf: any, backtest: PendingBacktest) {
        for (let strategyName in jsonConf.strategies)
        {
            let found = false;
            let i = 0;
            for (; i < backtest.strategies.length; i++)
            {
                if (backtest.strategies[i].getClassName() === strategyName || backtest.strategies[i].getBacktestClassName() === strategyName) {
                    found = true;
                    break;
                }
            }
            if (found === false)
                return false;
            if (backtest.currencyPair.toString() === jsonConf.strategies[strategyName].pair)
                return true;
        }
        return false;
    }

    protected forkBacktestProcess(configFilename: string, tradeConfig: TradeConfig, backtest: PendingBacktest) {
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
            logger.info("Starting backtest for config %s", childConfig);
            nodeArgs = utils.proc.addChildProcessArgument(nodeArgs, "--config", childConfig)
            let env = Object.assign({}, process.env)
            env.IS_CHILD = true
            env.PARENT_PROCESS_ID = process.pid;
            backtest.endMs = Date.now();
            env.START_TIME_MS = backtest.endMs - backtest.minutes*utils.constants.MINUTE_IN_SECONDS*1000; // TODO pack data into a message and send it via JSON
            env.END_TIME_MS = backtest.endMs;
            env.END_TOLERANCE_MIN = nconf.get("serverConfig:backtestImportToleranceMin");
            env.START_BALANCE = ""; // use default values. only the time range matters here
            env.SLIPPAGE = "";
            env.TRADING_FEE = "";
            env.SAVE_STATE = true;
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
                this.onChildMessage(configFilename, tradeConfig, message, backtest)
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

    protected onChildMessage(configFilename: string, tradeConfig: TradeConfig, message: any, backtest: PendingBacktest) {
        const backtestStartMs = Date.now() - backtest.minutes*utils.constants.MINUTE_IN_SECONDS*1000;
        let resetState = () => {
            setTimeout(() => {
                this.backtestWarmupState = BacktestWarmupState.IDLE;
                this.backtestRunning = false;
                this.startBacktest();
            }, nconf.get("serverConfig:resetWarmupBacktestErrorSec") * 1000)
        }
        switch (message.type)
        {
            case 'result':
                //let result: BotEvaluation = message.result;
                logger.info('Received backtest results from import child: bot %s%, market %s%', message.result.botEfficiencyPercent, message.result.marketEfficiencyPercent)
                this.backtestWarmupState = BacktestWarmupState.BACKTEST_DONE;
                let stateFilePath = path.join(utils.appDir, nconf.get("tradesDir"), "Backtester-" + tradeConfig.name + "-temp.json");
                this.restoreStateFromBacktest(stateFilePath);
                resetState();
                break;
            case 'tick':
                const range = backtest.endMs - backtestStartMs;
                let percent = Math.floor((message.data.timeMs - backtestStartMs) / range * 100.0 * 100) / 100.0;
                logger.verbose("Backtest progress is at %s %%", percent)
                break;
            case 'startImport':
                logger.info("Start importing trade history of %s", message.exchange)
                this.backtestWarmupState = BacktestWarmupState.IMPORTING;
                break;
            case 'profitPartialWarning':
                break;
            case 'importTick':
                //message.data.percent
                break;
            case 'autoImportNotSupported':
                break;
            case 'errorImport':
                logger.error("Error importing trade history of %s", message.exchange)
                this.backtestWarmupState = BacktestWarmupState.IMPORT_FAILED;
                resetState();
                break;
            case 'error':
                logger.error('Backtest child process error', message.error)
                this.backtestWarmupState = BacktestWarmupState.BACKTEST_FAILED;
                resetState();
                break;
            default:
                if (message.type === undefined && message.cmd && message.cmd === 'log')
                    break; // child process logs
                logger.warn('Received unknown backtest child message of type: %s', message.type)
        }
    }

    protected restoreStateFromBacktest(filePath: string) {
        return new Promise<void>((resolve, reject) => {
            fs.readFile(filePath, {encoding: "utf8"}, (err, data) => {
                if (err) {
                    logger.error("Error reading file to restore state from backtest", err);
                    return resolve();
                }
                let unpackState = utils.text.isPossibleJson(data) ? Promise.resolve(data) : utils.text.unpackGzip(data)
                unpackState.then((unpackedStr) => {
                    let state = utils.parseEJson(unpackedStr)
                    if (state)
                        this.unserializeStrategyData(state, filePath)
                }).catch((err) => {
                    logger.error("Error unpacking state string", err)
                })
            })
        })
    }

    protected checkRestoreConfig(forceOnlyRestoreFileNames: string[] = []) {
        return new Promise<void>((resolve, reject) => {
            if (!nconf.get("serverConfig:user:restoreCfg") && forceOnlyRestoreFileNames.length === 0)
                return resolve();
            const configDir = TradeConfig.getConfigRootDir();
            const backupDir = TradeConfig.getConfigBackupRootDir();
            if (fs.existsSync(backupDir) === false) {
                logger.error("Can not restore config on first start")
                return resolve();
            }
            utils.file.listDir(backupDir, async (err, files) => {
                if (err) {
                    logger.error("Error reading config backup dir", err);
                    return resolve();
                }
                let fileOps = [];
                files.forEach((file) => {
                    if (forceOnlyRestoreFileNames.length !== 0 && forceOnlyRestoreFileNames.indexOf(file) === -1)
                        return;
                    let fullSrcPath = path.join(backupDir, file); // opposite as when backing up
                    let fullDestPath = path.join(configDir, file);
                    fileOps.push(utils.file.copyFile(fullSrcPath, fullDestPath, true));
                });
                try {
                    logger.info("Restoring backup of %s config files", fileOps.length)
                    await fileOps;
                    nconf.set("serverConfig:user:restoreCfg", false)
                    serverConfig.saveConfigLocal();
                }
                catch (err) {
                    logger.error("Error restoring config backup", err)
                }
                resolve();
            });
        })
    }

    protected ensureDefaultFallbackConfig() {
        return new Promise<void>(async (resolve, reject) => {
            const configDir = TradeConfig.getConfigDirForMode("trading");
            const backupDir = TradeConfig.getConfigBackupRootDir();
            if (fs.existsSync(backupDir) === false)
                return resolve(); // shouldn't happen since we backup first
            const fileName = nconf.get("serverConfig:fallbackTradingConfig") + ".json";
            const fallbackConfigFile = path.join(configDir, fileName);
            if (fs.existsSync(fallbackConfigFile) === false) {
                await this.checkRestoreConfig([fileName]);
                if (fs.existsSync(fallbackConfigFile) === false)
                    logger.error("Unable to find default fallback config file %s", fallbackConfigFile)
            }
        })
    }

    protected abstract connectCandles(): void;
    protected abstract attachCandleBatcher(batcher: CandleBatcher<any>, attachedCurrentCandleListeners: boolean): void;

    protected onCandleSubscriptionsStart() {
        this.sendNotification("Bot started", utils.sprintf("Config: %s\r\nActive markets: %s", this.getConfigName(), this.candleCurrencies));
        const userConfigs = nconf.get("serverConfig:userConfigs") || [];
        logger.info("User specific configurations: %s", (userConfigs.length !== 0 ? userConfigs.join(", ") : "none"));
    }

    protected sendNotification(headline: string, text: string = "-", requireConfirmation = false) {
        if (nconf.get("trader") === "Backtester" || nconf.get("serverConfig:premium") !== true)
            return;
        let notification = new Notification(headline, text, requireConfirmation);
        this.notifier.send(notification).then(() => {
        }).catch((err) => {
            logger.error("Error sending %s notification", this.className, err)
        });
        //this.lastNotification = new Date();
    }
}
