import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import * as _ from "lodash";
import {Currency, Trade, Order, Candle} from "@ekliptor/bit-models";
import {CandleStream, TradeBase} from "./CandleStream";

/**
 * Creates candles of x minutes from 1 minute candles of CandleMaker.
 */
export class CandleBatcher<T extends TradeBase> extends CandleStream<T> {
    protected interval: number; // candle size in minutes
    protected minuteCandles: Candle.Candle[] = [];
    protected lastCandle: Candle.Candle = null; // the last full (batched) candle
    protected lastSmallCandle: Candle.Candle = null; // the last small incoming candle
    protected isMax = false; // this instance has the max interval for this currency pair
    protected currentCandleEmitTimer: NodeJS.Timer = null;

    constructor(interval: number, currencyPair: Currency.CurrencyPair, exchange: Currency.Exchange = Currency.Exchange.ALL) {
        super(currencyPair, exchange)
        this.interval = interval;
        if (!this.interval || !_.isNumber(this.interval) || this.interval <= 0)
            throw new Error("Candle size has to be a positive number");
    }

    public getInterval() {
        return this.interval;
    }

    public addCandles(candles: Candle.Candle[]) {
        if (candles.length !== 0)
            this.lastSmallCandle = candles[candles.length-1];
        else
            this.checkCandleReady();
        // loop through our 1 minute candles and emit x minute candles at the right time
        _.each(candles, (candle) => {
            this.minuteCandles.push(candle);
            this.checkCandleReady();
        });
    }

    public updateCurrentCandle(candle: Candle.Candle) {
        if (this.listenerCount("currentCandle") === 0)
            return; // faster
        let minuteCandles = [];
        for (let i = 0; i < this.minuteCandles.length; i++)
        {
            if (i === 0) // props get modified on the 1st
                minuteCandles.push(CandleBatcher.cloneCandle(this.minuteCandles[0]));
            else
                minuteCandles.push(this.minuteCandles[i]);
        }
        minuteCandles.push(candle); // add the incomplete one
        let batchedIncomplete = CandleBatcher.batchCandles(minuteCandles, this.interval, false);
        //console.log("incoming candle %s %s, listeners %s, interval %s", candle.start, candle.close, this.listenerCount("currentCandle"), this.interval)
        this.emitCurrentCandle(batchedIncomplete);
    }

    public setMax(max: boolean) {
        this.isMax = max;
    }

    public getMax() {
        return this.isMax;
    }

    /**
     * Batch candles to a single larger candle.
     * Candles can have different candle sizes. The start date of the new candle will be the value of the 1st candle.
     * @param smallCandles
     * @param interval
     * @param copyCandles
     */
    public static batchCandles(smallCandles: Candle.Candle[], interval: number = 0, copyCandles = true): Candle.Candle {
        if (copyCandles)
            smallCandles = CandleBatcher.cloneCandles(smallCandles); // ensure we don't modify any data of candles being used outside of this class
        if (!interval)
            interval = smallCandles[0].interval*smallCandles.length; // assume all candles are the same size
        const first = CandleBatcher.cloneCandle(smallCandles.shift()); // always copy the first one because properties get modified
        first.vwp = first.vwp * first.volume;

        let candle = _.reduce<Candle.Candle, Candle.Candle>(
            smallCandles,
            (candle, m) => { // TODO check if currency pair & exchange match? but this error shouldn't happen
                candle.high = _.max([candle.high, m.high]);
                candle.low = _.min([candle.low, m.low]);
                candle.close = m.close;
                candle.volume += m.volume;
                candle.upVolume += m.upVolume;
                candle.downVolume += m.downVolume;
                candle.vwp += m.vwp * m.volume;
                candle.trades += m.trades;
                if (candle.tradeData/* !== undefined*/)
                    candle.tradeData = candle.tradeData.concat(m.tradeData);
                return candle;
            },
            first // accumulator = candle, m = current candle
        );

        if (candle.volume) {
            // we have added up all prices (relative to volume)
            // now divide by volume to get the Volume Weighted Price
            candle.vwp /= candle.volume;
        }
        else
        // empty candle
            candle.vwp = candle.open;

        candle.start = first.start;
        candle.interval = interval;
        CandleStream.computeCandleTrend(candle);
        return candle;
    }

    /**
     * Emits all pending candles (if there are any) and clear the buffer.
     * Normally you don't have to call this, just use addCandles()
     */
    public flush() {
        if (this.minuteCandles.length === 0)
            return;
        this.lastCandle = this.calculate();
        this.emitCandles([this.lastCandle]);
        this.minuteCandles = [];
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected checkCandleReady() {
        const ensureInterval = nconf.get("serverConfig:ensureCandleHourInterval");
        if (ensureInterval === false && this.minuteCandles.length % this.interval !== 0) {
            //let incompleteCandle = CandleBatcher.batchCandles(this.minuteCandles, this.interval, true); // better done within the updates of latest 1min candle
            //this.emitCurrentCandle(incompleteCandle);
            return;
        }
        if (this.lastSmallCandle === null)
            return; // shouldn't happen
        else if (this.minuteCandles.length < this.interval)
            return; // not enough data yet
        else if (ensureInterval === true) { // keep the candles in sync with the clock (independently of bot start time)
            const candleMinutes = this.lastSmallCandle.start.getMinutes();
            const intervals = [1440 /*1 day*/, 240, 180, 120, 60, 30, 15, 5, 3]; // the order from highest to lowest is important
            for (let i = 0; i < intervals.length; i++)
            {
                if (this.interval % intervals[i] === 0) { // this candle config is a multiple of one of our specified intervals
                    if (candleMinutes % intervals[i] !== 0) // return if the current candle minute is not a multiple of that same interval
                        return;
                }
            }
        }

        this.lastCandle = this.calculate(this.interval);
        this.emitCandles([this.lastCandle]);
        //this.minuteCandles = []; // don't remove all. if we get candles very fast (backtesting) some candles might get swallowed otherwise
        this.minuteCandles.splice(0, this.interval); // modifies array
    }

    protected emitCurrentCandle(candle: Candle.Candle) {
        if (this.currentCandleEmitTimer !== null) // don't emit too much which slows down the process
            clearTimeout(this.currentCandleEmitTimer);
        this.currentCandleEmitTimer = setTimeout(() => {
            this.emit("currentCandle", candle);
        }, 10);
    }

    protected calculate(maxNumCandles: number = -1) {
        let candlesToBatch = this.minuteCandles;
        if (maxNumCandles !== -1)
            candlesToBatch = candlesToBatch.slice(0, maxNumCandles);
        return CandleBatcher.batchCandles(candlesToBatch, this.interval,false);
    }

    protected static cloneCandles(candles: Candle.Candle[]): Candle.Candle[] {
        let clones = [];
        for (let i = 0; i < candles.length; i++)
            clones.push(CandleBatcher.cloneCandle(candles[i]));
        return clones;
    }

    protected static cloneCandle(candle: Candle.Candle): Candle.Candle {
        //return _.cloneDeep(candle); // only copy root properties to save memory. especially trade objects on candle
        let tradeData = candle.tradeData;
        delete candle.tradeData;
        let copy: Candle.Candle = Object.assign(new Candle.Candle(candle.currencyPair), candle);
        candle.tradeData = tradeData;
        copy.tradeData = tradeData;
        return copy;
    }
}
