import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import {AbstractStrategy, StrategyAction, ScheduledTrade} from "./AbstractStrategy";
import {TechnicalStrategy, TechnicalStrategyAction} from "./TechnicalStrategy";
import {AbstractIndicator} from "../Indicators/AbstractIndicator";
import {Currency, Trade, Candle} from "@ekliptor/bit-models";


interface StcAction extends TechnicalStrategyAction {
    // strategy config when to go long/short
    low: number; // default 25 // Go long if STC goes up from this value.
    high: number; // default 75 // Go short if STC goes down from this value.
    closePositions: boolean; // default true. Close existing positions if an opposite signal occurs.

    // STC indicator config (optional)
    fast: number; // default 23, The number of fast EMA candles.
    slow: number; // default 50, The number of slow EMA candles.
    stcLength: number; // default 10, How many candles STC will keep to compute MACD signal and STC candle data.
    factor: number; // default 0.5, should be <= 1.0. A lower value means STC will forget historic data faster and be more responsive, thus doing more trades.
}

/**
 * Strategy that emits buy/sell based on the Schaff Trend Cycle. STC is a faster version of MACD that oscillates between 0 and 100.
 * Sell signals are given when STC goes down from a high and buy signals when it comes up from a low.
 * This strategy also closes positions if an opposite trade signal occurs.
 */
export default class STC extends TechnicalStrategy {
    public action: StcAction;
    protected lastSTC: number = -1; // identical ro OBV because it's updated on every candle tick
    protected secondLastSTC: number = -1;

    constructor(options) {
        super(options)
        if (!this.action.low)
            this.action.low = 25;
        if (!this.action.high)
            this.action.high = 75;
        if (typeof this.action.closePositions !== "boolean")
            this.action.closePositions = true;
        this.addIndicator("STC", "STC", this.action);

        this.addInfo("secondLastSTC", "secondLastSTC");
        this.addInfoFunction("STC", () => {
            return this.indicators.get("STC").getValue();
        });
        this.saveState = true;
    }

    public serialize() {
        let state = super.serialize();
        state.lastSTC = this.lastSTC;
        state.secondLastSTC = this.secondLastSTC;
        return state;
    }

    public unserialize(state: any) {
        super.unserialize(state);
        this.lastSTC = state.lastSTC;
        this.secondLastSTC = state.secondLastSTC;
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected tick(trades: Trade.Trade[]): Promise<void> {
        if (this.pendingOrder !== null && this.strategyPosition === "none") { // wait for an open position to close
            this.executeTrade(this.pendingOrder);
            this.pendingOrder = null;
        }
        return super.tick(trades);
    }

    protected checkIndicators() {
        let stc = this.indicators.get("STC")
        const value = stc.getValue();
        const valueFormatted = Math.round(value * 100) / 100.0;
        this.secondLastSTC = this.lastSTC;
        const valueFormatted2nd = Math.round(this.secondLastSTC * 100) / 100.0;

        if (this.secondLastSTC > this.action.high && value <= this.action.high) {
            // go short
            const reason = utils.sprintf("STC value passing high threshold DOWN. prev %s, current %s", valueFormatted2nd, valueFormatted);
            this.log(reason);
            if (this.strategyPosition === "none")
                this.emitSell(this.defaultWeight, reason);
            else if (this.strategyPosition === "long" && this.action.closePositions === true) {
                this.emitClose(this.defaultWeight, reason);
                this.pendingOrder = new ScheduledTrade("sell", this.defaultWeight, reason, this.className);
            }
        }
        else if (this.secondLastSTC < this.action.low && value >= this.action.low) {
            // go long
            const reason = utils.sprintf("STC value passing low threshold UP. prev %s, current %s", valueFormatted2nd, valueFormatted);
            this.log(reason);
            if (this.strategyPosition === "none")
                this.emitBuy(this.defaultWeight, reason);
            else if (this.strategyPosition === "short" && this.action.closePositions === true) {
                this.emitClose(this.defaultWeight, reason);
                this.pendingOrder = new ScheduledTrade("buy", this.defaultWeight, reason, this.className);
            }
        }
        else
            this.log("No trend detected, STC", valueFormatted)

        this.lastSTC = value;
    }
}
