import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import {AbstractStrategy, StrategyAction} from "./AbstractStrategy";
import {TechnicalStrategy, TechnicalStrategyAction} from "./TechnicalStrategy";
import {AbstractIndicator} from "../Indicators/AbstractIndicator";
import {Currency, Trade, Candle} from "@ekliptor/bit-models";
import {RSIMode} from "./RSI";

interface StochRsiAction extends TechnicalStrategyAction {
    low: number;
    high: number;
    interval: number; // the RSI interval

    // optional values
    optInFastK_Period: number; // default 5. The number of candles for the real (not smoothened) StochRSI value.
    optInFastD_Period: number; // default 3. The number of candles for the smoothened StochRSI value. This strategy will use the smoothened StochRSI value for trading.
    optInFastD_MAType: number; // default 0=SMA. The moving average type to use for smoothening the StochRSI value.
    mode: RSIMode; // default "trend". if "reverse" buy on RSI low and sell on RSI high (only if currentRSI > lastRSI)
}

/**
 * Strategy that emits buy/sell based on the Stochastic RSI indicator. StochRSI is an oscillator measuring the RSI low/high
 * values relative to relative to the min and max RSI values over the by 'interval' defined period of candles. This makes StochRSI
 * and indicator of an indicator. The advantage is that StochRSI is guaranteed to reach either its low or high values, thus producing
 * more signals.
 */
export default class StochRSI extends TechnicalStrategy {
    public action: StochRsiAction;
    protected lastRSI: number = -1; // identical ro RSI because it's updated on every candle tick
    protected secondLastRSI: number = -1;

    constructor(options) {
        super(options)
        if (typeof this.action.mode !== "string")
            this.action.mode = "trend";
        this.addIndicator("StochRSI", "StochRSI", this.action);

        this.addInfo("secondLastRSI", "secondLastRSI");
        let rsi = this.getStochRSI("StochRSI")
        this.addInfoFunction("StochRSID", () => {
            return rsi.getOutFastD();
        });
        this.addInfoFunction("StochRSIK", () => {
            return rsi.getOutFastK();
        });
        this.saveState = true;
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected checkIndicators() {
        let rsi = this.getStochRSI("StochRSI")
        const value = rsi.getOutFastD();
        const valueFormatted = Math.round(value * 100) / 100.0;
        this.secondLastRSI = this.lastRSI;
        // TODO check for this.action.thresholds.persistence, add a counter
        if (this.action.mode !== "trend") {
            // use lastRSI to ensure we don't miss our entry point
            if (this.lastRSI < this.action.low && value > this.lastRSI && value > this.action.low) {
                this.log("DOWN reverse trend detected, value", valueFormatted)
                this.emitBuy(this.defaultWeight, "RSI value: " + valueFormatted);
            }
            else if (this.lastRSI > this.action.high && value < this.lastRSI && value < this.action.high) {
                this.log("UP reverse trend detected, value", valueFormatted)
                this.emitSell(this.defaultWeight, "RSI value: " + valueFormatted);
            }
            else
                this.log("no (reverse) trend detected, value", valueFormatted)
        }
        if (this.action.mode !== "reverse") {
            if (value > this.action.high) {
                this.log("UP trend detected, value", valueFormatted)
                this.emitBuy(this.defaultWeight, "RSI value: " + valueFormatted);
            }
            else if (value < this.action.low) {
                this.log("DOWN trend detected, value", valueFormatted)
                this.emitSell(this.defaultWeight, "RSI value: " + valueFormatted);
            }
            else
                this.log("no trend detected, value", valueFormatted)
        }
        this.lastRSI = value;
    }
}