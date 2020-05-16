
// TODO look at low/high values of candles to see if there is actual resistance at a certain price (not just on the order book)
// then we can buy a lot of coins at that level and wait for the price to move the other way
// obviously bad if the resistance breaks -> send a stronger buy/sell signal in the other direction then

// TODO 2nd idea: look at trades and check if the price can't get past a certain point (+/- a few %)


import * as utils from "@ekliptor/apputils";
const logger = utils.logger
    , nconf = utils.nconf;
import {AbstractStrategy, StrategyAction} from "./AbstractStrategy";
import {Currency, Trade} from "@ekliptor/bit-models";


/**
 */
export default class ResistanceBuyer extends AbstractStrategy {
    constructor(options) {
        super(options)
        throw new Error(this.className + " is not yet implemented");
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected tick(trades: Trade.Trade[]) {
        return new Promise<void>((resolve, reject) => {
            resolve()
        })
    }
}