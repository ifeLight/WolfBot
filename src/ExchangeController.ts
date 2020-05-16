import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import {AbstractSubController} from "./AbstractSubController";
import {AbstractExchange, ExchangeMap} from "./Exchanges/AbstractExchange";
import {Brain} from "./AI/Brain";
import {ConfigEditor} from "./WebSocket/ConfigEditor";
import {TradeConfig, ConfigCurrencyPair} from "./Trade/TradeConfig";
import {Currency, Process, serverConfig} from "@ekliptor/bit-models";
import * as db from'./database';
import * as path from "path";
import * as fs from "fs";
import {CandleMaker} from "./Trade/Candles/CandleMaker";
import {AbstractContractExchange} from "./Exchanges/AbstractContractExchange";
import {LendingConfig} from "./Lending/LendingConfig";
import {AbstractLendingExchange} from "./Exchanges/AbstractLendingExchange";
import {ArbitrageConfig} from "./Arbitrage/ArbitrageConfig";
import {AbstractNotification} from "./Notifications/AbstractNotification";
import Notification from "./Notifications/Notification";



export default class ExchangeController extends AbstractSubController {
    protected static readonly WAIT_CONFIG_ONCE_MS = 3000;
    protected static readonly EXCHANGE_KEYS_BACKUP_FILE = "exchangeKeys.json";

    // cache instances to keep WebSocket connections (and other state)
    protected configFilename: string;
    protected exchanges = new ExchangeMap(); // (exchange name, instance)
    protected configs: TradeConfig[] = [];
    protected connectedExchanges: string[] = []; // the exchanges we are interested in according to our config
    protected exchangesIdle: boolean = false;
    protected configReady = false;

    protected notifier: AbstractNotification;

    constructor(configFilename: string) {
        super()
        this.notifier = AbstractNotification.getInstance(true);
        this.configFilename = configFilename.replace(/"*$/g, "").replace(/^"*/g, ""); // remove  possible "
        if (this.configFilename !== undefined && typeof this.configFilename !== "string") {
            // @ts-ignore
            this.configFilename = this.configFilename.toString();
        }
        if (!this.configFilename)
            return; // updater instance...
        if (this.configFilename.substr(-5) !== ".json")
            this.configFilename += ".json";
        nconf.set("exchangeParams", []); // reset on startup
        this.ensureAllExchangesPresent();
        this.loadConfig();
        // TODO "quickstart" for live trading
        // 1. fetch trade history of last x days (can be a lot to be sure)
        // 2. start a Backtester trader to warm up strategies
        // 3. start a 2nd process to ensure that backtester has all the data until NOW before termination
        // 4. send an event to Controller to replace TradeAdvisor & ExchangeController, keep strategies and connect them with RealTimeTrader
    }

    public process() {
        return new Promise<void>((resolve, reject) => {
            utils.file.touch(AbstractExchange.cookieFileName).then(() => {
                return utils.promiseDelay(this.configReady === true ? 0 : ExchangeController.WAIT_CONFIG_ONCE_MS); // wait once
            }).then(() => {
                if (!process.env.IS_CHILD) // don't attempt to create dirs on every child process
                    return this.ensureDir(utils.appDir, [nconf.get("tempDir")])
            }).then(() => {
                if (!process.env.IS_CHILD) // don't attempt to create dirs on every child process
                    return this.ensureDir(utils.appDir, [nconf.get("tradesDir"), Brain.TEMP_DATA_DIR, CandleMaker.TEMP_DATA_DIR])
            }).then(() => {
                if (!process.env.IS_CHILD)
                    return this.ensureDir(path.join(utils.appDir, nconf.get("tradesDir")), [nconf.get("backfindDir")])
            }).then(() => {
                if (!process.env.IS_CHILD)
                    return this.ensureDir(path.join(utils.appDir, nconf.get("tempDir")), [Brain.TEMP_DATA_DIR]) // doesn't really belong here
            }).then(() => {
                if (!process.env.IS_CHILD)
                    return this.ensureDir(path.join(utils.appDir, nconf.get("tempDir")), [CandleMaker.TEMP_DATA_DIR]) // doesn't really belong here
            }).then(() => {
                /* // we have to continue without loading any exchanges, so that ConfigEditor gets initialized for a possible restart
                if (this.configReady === false) {
                    logger.error("Config is not ready in %s. Bot trading mode or config most likely wrong (not existing?). Please fix this and restart the bot.", this.className)
                    return Promise.reject();
                }
                */
                return Process.getActiveCount(db.get(), null, true);
            }).then((activeProcessCount) => {
                this.loadExchanges(activeProcessCount)
                return this.getTickers()
            }).then(() => {
                resolve()
            }).catch((err) => {
                logger.error("Error in ExchangeController", err)
                const Controller = require('./Controller').controller // has to be loaded after this file is included
                Controller.handleDatabaseConnectionError(err); // will restart if true
                resolve() // continue
            })
        })
    }

    public getExchanges() {
        return this.exchanges;
    }

    public isExchangesIdle() {
        return this.exchangesIdle;
    }

    public getConfigFilename() {
        return this.configFilename.replace(/\.json$/, "");
    }

    /**
     * Loads a single new exchange instance. Useful for social crawler and other non-trading bots.
     * @param {string} exchangeName
     * @returns {Promise<AbstractExchange>}
     */
    public async loadSingleExchange(exchangeName: string): Promise<AbstractExchange> {
        let activeProcessCount = await Process.getActiveCount(db.get());
        let apiKeys = nconf.get("serverConfig:apiKey:exchange")
        let exchangeKey = apiKeys[exchangeName];
        if (Array.isArray(exchangeKey) === true) { // support for single API key per process (to avoid conflicts in nonce == increasing integer)
            let i = activeProcessCount % exchangeKey.length;
            logger.info("Loading exchange %s with apiKey index %s", exchangeName, i)
            exchangeKey = exchangeKey[i];
        }
        else
            logger.info("Loading exchange %s", exchangeName)
        const modulePath = path.join(__dirname, "Exchanges", exchangeName);
        let exchangeInstance = this.loadModule<AbstractExchange>(modulePath, exchangeKey);
        if (exchangeInstance) {
            if (nconf.get("lending") && !(exchangeInstance instanceof AbstractLendingExchange)) {
                logger.error("Lending is not supported on exchange %s", exchangeName)
                return null;
            }
        }
        return exchangeInstance;
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected loadExchanges(activeProcessCount: number) {
        if (this.exchangesIdle === true || this.configReady === false)
            return; // we need to restart our bot for TradeAvisor class to connect to exchanges + events // TODO improve
        if (nconf.get("social"))
            return;
        this.setExchangesIdle(false); // default is false, reset below
        if (nconf.get('trader') === "Backtester") {
            //let exchanges = nconf.get('defaultExchanges');
            let exchanges = this.connectedExchanges;
            if (exchanges.length > 1) // TODO improve this? or do we even need multiple exchanges per bot instance?
                logger.warn("Backtesting only works with the first 1 default exchange and the first currency. Using %s", exchanges[0])
            const exchangeName = exchanges[0]
            const exchangeLabel = Currency.ExchangeName.get(exchangeName);
            const modulePath = path.join(__dirname, "Exchanges", "HistoryDataExchange");
            let exchangeInstance = this.loadModule<AbstractExchange>(modulePath, {
                exchangeName: exchangeName,
                exchangeLabel: exchangeLabel
            });
            if (exchangeInstance)
                this.exchanges.set(exchangeName, exchangeInstance);
            return;
        }
        this.tryLoadExchangKeys(activeProcessCount);
        if (this.isExchangesIdle() ===  true) { // sometimes nconf is slower reading initial data?
            setTimeout(async () => {
                if (this.isExchangesIdle() !==  true)
                    return;
                await this.loadExchangeKeyBackup();
                this.tryLoadExchangKeys(activeProcessCount);
            }, 2500);
        }
    }

    protected tryLoadExchangKeys(activeProcessCount: number) {
        let apiKeys = nconf.get("serverConfig:apiKey:exchange");
        if (!apiKeys || apiKeys.length === 0) {
            this.setExchangesIdle(true);
            logger.warn("No exchange keys found in config. All exchanges are idle");
            return;
        }
        for (let ex in apiKeys)
        {
            if (this.connectedExchanges.indexOf(ex) === -1)
                continue; // we are not interested in this exchange
            if (this.exchanges.has(ex))
                continue; // already loaded

            let exchangeKey = apiKeys[ex];
            if (Array.isArray(exchangeKey) === true) { // support for single API key per process (to avoid conflicts in nonce == increasing integer)
                if (exchangeKey.length === 0) {
                    this.setExchangesIdle(true); // we could add some exchanges, but then we have to modify TradeAdvisor to skip others
                    logger.warn("No exchange keys found for %s in config. Keeping exchanges idle.", ex);
                    return;
                }
                let i = activeProcessCount % exchangeKey.length;
                logger.info("Loading exchange %s with apiKey index %s", ex, i)
                exchangeKey = exchangeKey[i];
            }
            else {
                if (!exchangeKey) {
                    this.setExchangesIdle(true);
                    logger.warn("Invalid exchange key found for %s in config. Keeping exchanges idle.", ex);
                    return;
                }
                logger.info("Loading exchange %s", ex)
            }
            if (!exchangeKey.key || !exchangeKey.secret) {
                this.setExchangesIdle(true);
                logger.warn("Empty exchange key/secret found for %s in config. Keeping exchanges idle.", ex);
                return;
            }
            const modulePath = path.join(__dirname, "Exchanges", ex);
            let exchangeInstance = this.loadModule<AbstractExchange>(modulePath, exchangeKey);
            if (exchangeInstance) {
                if (nconf.get("lending") && !(exchangeInstance instanceof AbstractLendingExchange)) {
                    logger.error("Lending is not supported on exchange %s", ex)
                    continue;
                }
                this.exchanges.set(ex, exchangeInstance);
                this.setExchangesIdle(false);
            }
        }
        if (this.exchangesIdle === false)
            this.saveExchangeKeyBackup(); // better don't delay it to ensure we have this exact config
    }

    protected getTickers() {
        return new Promise<void>((resolve, reject) => {
            if (nconf.get('trader') === "Backtester" || nconf.get("social"))
                return resolve(); // no ticker available
            // lending needs the exchange ticker for exchanges rates
            //else if (nconf.get("lending"))
                //return resolve(); // some exchanges (Bitfinex) have lending tickers, but we don't need them

            let ticketOps = []
            const now = Date.now()
            for (let ex of this.exchanges)
            {
                let tickerMap = ex[1].getTickerMap();
                if (tickerMap.size !== 0 && tickerMap.getCreated().getTime() + nconf.get('serverConfig:tickerExpirySec')*1000 > now)
                    continue // already fetched
                tickerMap.setCreated(new Date(now)); // update the timestamp to prevent fetching it multiple times
                ticketOps.push(new Promise((resolve, reject) => {
                    ex[1].getTicker().then((ticker) => {
                        ex[1].setTickerMap(ticker);
                        logger.verbose("Fetched ticker of %s", ex[0])

                        if (ex[1] instanceof AbstractContractExchange)
                            return (ex[1] as AbstractContractExchange).getIndexPrice();
                    }).then((index) => {
                        if (index) {
                            (ex[1] as AbstractContractExchange).setIndexPrice(index)
                        }
                        resolve()
                    }).catch((err) => {
                        resolve() // continue loading tickers from other exchanges
                    })
                }))
            }
            Promise.all(ticketOps).then(() => {
                resolve()
            }).catch((err) => {
                reject(err)
            })
        })
    }

    protected ensureAllExchangesPresent() {
        const emptyConfig = new serverConfig.ServerConfig();
        let exchanges = Array.from(Currency.ExchangeName.keys());
        let saveKeys = false;
        exchanges.forEach((exchange) => {
            let exchangeConf = nconf.get("serverConfig:apiKey:exchange:" + exchange);
            if (exchangeConf && Array.isArray(exchangeConf) === true)
                return;
            const msg = utils.sprintf("Exchange %s api key config is missing or invalid, restoring defaults", exchange);
            logger.error(msg);
            this.notifyError(msg); // TODO add a list of recently added exchanges and skip this error message for them
            nconf.set("serverConfig:apiKey:exchange:" + exchange, emptyConfig.apiKey.exchange[exchange]);
            saveKeys = true;
        });
        // @ts-ignore
        if (saveKeys === true)
            serverConfig.saveConfigLocal();
    }

    protected loadConfig() {
        let filePath = path.join(ConfigEditor.getConfigDir(), this.configFilename);
        let data = "";
        try {
            data = fs.readFileSync(filePath, {encoding: "utf8"});
        }
        catch (err) {
            if (err && err.code === "ENOENT") {
                /**
                 * 2018-10-20 21:07:26 - warn: Unable to load config file /home/bitbrain2/nodejs/BitBrain2/Sensor1/config/Bitfinex.json in ExchangeController - most likely wrong trading mode after restart. Retrying defaults
                 2018-10-20 21:07:26 - error: Unable to load config /home/bitbrain2/nodejs/BitBrain2/Sensor1/config/Bitfinex.json in ExchangeController. Most likely invalid trading mode and config file. Please fix this and restart the bot.
                 2018-10-20 21:07:29 - warn: Unhandled Rejection
                 2018-10-20 21:07:29 - warn:  {"message":"ENOENT: no such file or directory, open '/home/bitbrain2/nodejs/BitBrain2/Sensor1/config/Bitfinex.json'","stack":"Error: ENOENT: no such file or directory, open '/home/bitbrain2/nodejs/BitBrain2/Sensor1/config/Bitfinex.json'\n    at Object.openSync (fs.js:434:3)\n    at Object.readFileSync (fs.js:339:35)\n
                  at TradeAdvisor.loadConfig (/home/bitbrain2/nodejs/BitBrain2/src/TradeAdvisor.ts:427:23)\n
                  at TradeAdvisor.checkRestoreConfig.then (/home/bitbrain2/nodejs/BitBrain2/src/TradeAdvisor.ts:213:18)","errno":-2,"syscall":"open","code":"ENOENT","path":"/home/bitbrain2/nodejs/BitBrain2/Sensor1/config/Bitfinex.json"}
                 */
                const filePathTrading = path.join(TradeConfig.getConfigDirForMode("trading"), this.configFilename);
                if (fs.existsSync(filePathTrading) === true) {
                    this.scheduleRestart(false, true);
                    return;
                }

                logger.warn("Unable to load config file %s in %s - most likely wrong trading mode after restart. Retrying defaults", filePath, this.className);
                if (nconf.get("trader") === "Backtester")
                    return;
                const paramsFile = path.join(/*utils.appDir, */nconf.get("lastParamsFile")); // use working dir
                fs.unlink(paramsFile, (err) => {
                    if (err && err.code !== "ENOENT")
                        logger.warn("Error deleting last params file on new start", err);
                });
                this.copyFallbackConfigFile(filePath);
                const lastWorking = new Date(nconf.get("serverConfig:lastWorkingConfigTime") || 0);
                if (lastWorking.getTime() + nconf.get("serverConfig:lastWorkingResetConfigMin")*utils.constants.MINUTE_IN_SECONDS*1000 < Date.now()) {
                    nconf.set("serverConfig:lastWorkingConfigName", nconf.get("serverConfig:fallbackTradingConfig"));
                    serverConfig.saveConfigLocal();
                }
                if (TradeConfig.isTradingMode() === false || this.getConfigFilename() !== "Noop") { // TODO always ensure this file exists
                    this.scheduleRestart(true);
                    return;
                }
            }
            logger.error("Unable to load config %s in %s. Most likely invalid trading mode and config file. Please fix this and restart the bot.", filePath, this.className)
            // TODO improve this. also try specific modes? how can we recover if everything fails? restore backup?
            return;
        }
        if (!data) {
            logger.error("Can not load config file under: %s", filePath)
            return
        }
        let json = utils.parseJson(data);
        if (!json || !json.data) {
            logger.error("Invalid JSON in config file: %s", filePath)
            return
        }
        json = TradeConfig.ensureConfigSchema(json);
        if (json === null) {
            logger.error("Invalid JSON in config schema in file: %s", filePath);
            return;
        }
        fs.writeFileSync(filePath, utils.stringifyBeautiful(json), {encoding: "utf8"});
        let connectedExchanges = [];
        const filterExchanges: string[] = nconf.get("serverConfig:filterExchanges");
        const lastWorking = new Date(nconf.get("serverConfig:lastWorkingConfigTime") || 0);
        let configChanged = false;
        try {
            if (nconf.get("lending") && json.data.length === 1)
                json.data = LendingConfig.expandConfig(json.data[0]);
            json.data.forEach((conf) => {
                let config;
                try {
                    if (nconf.get("lending"))
                        config = new LendingConfig(conf, this.configFilename);
                    else if (nconf.get("arbitrage"))
                        config = new ArbitrageConfig(conf, this.configFilename);
                    else
                        config = new TradeConfig(conf, this.configFilename);
                } catch (e) {
                    logger.error("Error loading config. Please fix your config and restart the app", e);
                    return;
                }
                this.configs.push(config)

                // just get the names
                //const configExchanges = this.pipeMarketStreams(config);
                let replacedExchange = false;
                if (nconf.get("debug") !== true && TradeConfig.getTradingMode() === "trading" && lastWorking.getTime() + nconf.get("serverConfig:lastWorkingResetConfigMin")*utils.constants.MINUTE_IN_SECONDS*1000 < Date.now()) {
                    filterExchanges.forEach((filterEx) => {
                        let removePos = config.exchanges.indexOf(filterEx);
                        if (removePos !== -1) {
                            logger.warn("Replacing %s exchange with %s in config %s due to unstable connection", filterEx, nconf.get("serverConfig:replaceExchange"), this.configFilename);
                            //config.exchanges.splice(removePos, 1);
                            config.exchanges[removePos] = nconf.get("serverConfig:replaceExchange");
                            replacedExchange = true;
                            configChanged = true;
                        }
                    });
                }
                const exchangeNames = config.exchanges;
                connectedExchanges = connectedExchanges.concat(exchangeNames);
                // @ts-ignore
                if (replacedExchange === true)
                    config.exchanges = utils.uniqueArrayValues(config.exchanges);
            });
        }
        catch (err) {
            logger.error("Invalid config JSON syntax on startup", err);
            this.scheduleRestart(true, true);
            return;
        }

        // @ts-ignore
        if (configChanged === true)
            fs.writeFileSync(filePath, utils.stringifyBeautiful(json), {encoding: "utf8"});
        TradeConfig.resetCounter();
        LendingConfig.resetCounter();
        this.connectedExchanges = utils.uniqueArrayValues(connectedExchanges); // shouldn't change anything
        this.configReady = true;
    }

    protected async copyFallbackConfigFile(dest: string): Promise<void> {
        if (nconf.get("trader") === "Backtester")
            return; // can only be chosen from parent process with valid config files
        let filePath = path.join(TradeConfig.getConfigDirForMode("trading"), nconf.get("serverConfig:fallbackTradingConfig") + ".json");
        try {
            await fs.promises.copyFile(filePath, dest)
        }
        catch (err) {
            logger.error("Error copying fallback config from %s", filePath, err);
        }
    }

    protected setExchangesIdle(idle: boolean) {
        this.exchangesIdle = idle;
        nconf.set("serverConfig:exchangesIdle", idle);
    }

    protected scheduleRestart(forceDefaults: boolean, resetMode = false) {
        const configPathTrading = TradeConfig.getConfigDirForMode("trading", false);
        if (fs.existsSync(configPathTrading) === false) // if the backup dir doesn't exist this is the first install (or debugging)
            this.notifyError("Config error (not existing)");

        setTimeout(async () => { // WebsocketController is loaded after exchanges
            let controller = await import("./Controller");
            controller.controller.restart(forceDefaults, resetMode);
        }, ExchangeController.WAIT_CONFIG_ONCE_MS + 600);
    }

    protected notifyError(headline: string) {
        //const pauseMs = nconf.get('serverConfig:notificationPauseMin') * utils.constants.MINUTE_IN_SECONDS * 1000;
        //if (this.lastNotification && this.lastNotification.getTime() + pauseMs > Date.now()) // lastNotification per bot? we only monitor 1 instance per bot
            //return;

        let err = new Error();
        let notification = new Notification(headline, utils.sprintf("Config: %s, Mode: %s, Exchanges: %s\nLoaded Exchanges: %s\n%s", this.getConfigFilename(),
            TradeConfig.getTradingMode(), this.connectedExchanges, Array.from(this.getExchanges().keys()), err.stack.toString()), false);
        this.notifier.send(notification).then(() => {
        }).catch((err) => {
            logger.error("Error sending %s notification", "ExchangeController", err)
        });
        //this.lastNotification = new Date();
    }

    protected async saveExchangeKeyBackup() {
        let keys = nconf.get("serverConfig:apiKey:exchange");
        if (!keys) {
            logger.warn("Unable to save exchange key backup because no keys are available");
            return
        }
        const tempDir = path.join(utils.appDir, nconf.get('tempDir'))
        let backupPath = path.join(tempDir, ExchangeController.EXCHANGE_KEYS_BACKUP_FILE);
        try {
            await fs.promises.writeFile(backupPath, JSON.stringify(keys), {encoding: "utf8"})
        }
        catch (err) {
            logger.error("Error writing exchange key backup to: %s", backupPath, err);
        }
    }

    protected async loadExchangeKeyBackup() {
        const tempDir = path.join(utils.appDir, nconf.get('tempDir'))
        let backupPath = path.join(tempDir, ExchangeController.EXCHANGE_KEYS_BACKUP_FILE);
        try {
            let data = await fs.promises.readFile(backupPath, {encoding: "utf8"});
            let json = utils.parseJson(data);
            if (json === null) {
                logger.error("Invalid JSON in exchange key backup: %s", backupPath);
                return;
            }
            nconf.set("serverConfig:apiKey:exchange", json);
            logger.info("Restored exchange keys from backup");
        }
        catch (err) {
            if (err && err.code !== "ENOENT")
                logger.error("Error loading exchange key backup from: %s", backupPath, err);
        }
    }
}
