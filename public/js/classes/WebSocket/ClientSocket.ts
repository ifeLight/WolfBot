//import * as WebSocket from "ws"; // only works on server Side, Browsers have a native WebSocket object
import {WebSocketOpcode, AppJSONFormat} from "../../../../src/WebSocket/opcodes";
import {AbstractWidget} from "../AbstractWidget";
import {EventEmitter2} from "eventemitter2";
import {AppFunc, HelpersClass, EJSON} from "@ekliptor/browserutils";

declare var AppF: AppFunc, Hlp: HelpersClass;

export interface ClientSocketCallback {
    (data: any): void;
}

export abstract class ClientSocketReceiver extends AbstractWidget {
    public readonly opcode: WebSocketOpcode;
    protected socket: ClientSocket;
    protected persistent = false; // don't unsubscribe if we navigate to another page

    constructor(socket: ClientSocket) {
        super()
        this.socket = socket;
    }

    public abstract onData(data: any): void;

    public setPersistent(persistent: boolean) {
        this.persistent = persistent;
    }

    public isPersistent() {
        return this.persistent;
    }

    protected send(data: any) {
        this.socket.send(ClientSocket.stringify(this.opcode, data));
    }

    /**
     * Send a request via HTTP instead of WebSocket
     * @param {string} url The url to send it to. Can be a
     * @param data any JavaScript object to be sent as json in the "data" parameter
     * @param {ClientSocketCallback} callback (optional). If not supplied the this.onData() will be called
     *          In case of HTTP errors no callback will be called (just like we get nothing when our websocket connection aborts).
     */
    public sendHTTP(url: string, data: any, callback: ClientSocketCallback = null): void {
        if (!url)
            return AppF.log("ERROR: url parameter for sendHTTP() must be a string");
        let http = new XMLHttpRequest();
        if (/^https?:\/\//i.test(url) === false) {
            if (url[0] !== "/")
                url = "/" + url;
            url = this.getOrigin() + url;
            if (url[url.length-1] !== "/")
                url += "/";
        }
        let params = new FormData();
        params.append("data", JSON.stringify(data));
        http.onreadystatechange = (ev) => {
            if (http.readyState === 4) {
                if (http.status === 200) {
                    let jsonRes = JSON.parse(http.responseText);
                    if (typeof callback=== "function")
                        callback(jsonRes);
                    else
                        this.onData(jsonRes);
                }
                else
                    AppF.log("ERROR: Invalid HTTP response in sendHTTP() with code: " + http.status);
            }
        };
        http.open("POST", url, true);
        http.send(params);
    }

    protected getOrigin(): string {
        if (typeof document.location.origin === "string")
            return document.location.origin;
        else if (typeof window.origin === "string")
            return window.origin;
        return (document as any).origin; // legacy
    }
}

/**
 * A WebSocket implementation for HTML5 browsers.
 * Don't extend the native WebSocket object: https://stackoverflow.com/questions/35282843/how-should-i-extend-the-websocket-type-in-typescript
 * @events connect, disconnect
 */
export class ClientSocket extends EventEmitter2 {
    protected className: string;
    protected socket: WebSocket;
    /*
    protected t: TranslationFunction = (key: string) => {
        console.warn("No translation function provided in %s", this.className);
        return key; // dummy
    };
    */

    protected receivers = new Map<WebSocketOpcode, ClientSocketReceiver>();
    protected disconnectSent = false;

    constructor(url: string, protocols?: string | string[]) {
        super()
        this.className = this.constructor.name;
        this.socket = new WebSocket(url, protocols);

        this.socket.onerror = (error) => {
            AppF.log("WebSocket error", error);
            Hlp.showMsg(AppF.tr('connectionError'), 'danger');
        }
        this.socket.onopen = (event) => {
            //setTimeout(function() { // delay needed since new websocket module
            //}, HelpersClass.cfg.websocketConnectDelayMs);
            //this.socket.send(JSON.stringify({a: 1}));
            //that.startedInspector = new Date();
            this.emit("connect");
        }
        this.socket.onmessage = (event) => {
            if (typeof event.data !== "string")
                return AppF.log("Received WebSocket data with unexpected type", typeof event.data);
            const message = AppJSONFormat === "JSON" ? JSON.parse(event.data) : EJSON.parse(event.data);
            if (message[0] === WebSocketOpcode.FATAL_ERROR) {
                this.emitDisconnect(message[1].err);
                return AppF.log("Received WebSocket fatal error message:", message[1]);
            }
            if (message[0] === WebSocketOpcode.CLOSE) {
                this.emitDisconnect(message[1].txt);
                return AppF.log("Received WebSocket close message:", message[1]);
            }
            if (message[0] === WebSocketOpcode.ERROR || message[0] === WebSocketOpcode.WARNING) {
                let type = message[0] === WebSocketOpcode.ERROR ? "error" : "warning";
                return AppF.log("Received WebSocket %s message:", type, message[1]);
            }
            if (message[0] === WebSocketOpcode.PING)
                return;

            let receiver = this.receivers.get(message[0]);
            if (receiver !== undefined)
                receiver.onData(message[1]);
            else
                AppF.log("Received WebSocket data without corresponding receiver. Opcode ", message[0]);
        }
        this.socket.onclose = () => {
            this.socket = null;
            this.emitDisconnect();
        }
    }

    public static stringify(opcode: WebSocketOpcode, data: any) {
        if (AppJSONFormat === "JSON")
            return JSON.stringify([opcode, data])
        return EJSON.stringify([opcode, data])
    }

    public subscribe(receiver: ClientSocketReceiver, persistent = false) {
        receiver.setPersistent(persistent);
        if (this.receivers.has(receiver.opcode) === true)
            return;
        this.send(ClientSocket.stringify(receiver.opcode, {action: "sub"}));
        this.receivers.set(receiver.opcode, receiver);
    }

    public unsubscribe(receiver: ClientSocketReceiver) {
        if (receiver.isPersistent() === true)
            return;
        this.send(ClientSocket.stringify(receiver.opcode, {action: "unsub"}));
        this.receivers.delete(receiver.opcode);
    }

    public setAllowReSubscribe(receiver: ClientSocketReceiver) {
        receiver.setPersistent(false); // allow subscribing again to load the view
        this.receivers.delete(receiver.opcode);
    }

    public send(data: any): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
            return AppF.log("No WebSocket connection available to send data");
        this.socket.send(data);
    }

    public close() {
        let tryClose = () => {
            if (this.socket.bufferedAmount === 0)
                this.socket.close();
            else
                setTimeout(tryClose.bind(this), 1000);
        }
        tryClose();
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected emitDisconnect(reason?: string) {
        if (this.disconnectSent === true)
            return;
        this.emit("disconnect", reason);
        this.disconnectSent = true;
    }
}