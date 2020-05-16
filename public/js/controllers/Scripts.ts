import {ClientSocketReceiver, ClientSocket} from "../classes/WebSocket/ClientSocket";
import {AbstractController} from "./base/AbstractController";
import {WebSocketOpcode} from "../../../src/WebSocket/opcodes";
import {PageData} from "../types/PageData";
import {AppData} from "../types/AppData";
import {AppFunc, HelpersClass, EJSON} from "@ekliptor/browserutils";
import {ScriptsReq, ScriptsRes} from "../../../src/WebSocket/ScriptsUpdater";


declare var pageData: PageData, appData: AppData;
declare var AppF: AppFunc, Hlp: HelpersClass;

export class Scripts extends AbstractController {
    public readonly opcode = WebSocketOpcode.SCRIPTS;

    constructor(socket: ClientSocket) {
        super(socket)
    }

    public onData(data: ScriptsRes) {
        if (data.error)
            return Hlp.showMsg(data.errorTxt ? data.errorTxt : AppF.tr(data.errorCode ? data.errorCode : 'unknownError'), 'danger');

    }

    public render() {
        return new Promise<string>((resolve, reject) => {
            let status = AppF.translate(pageData.html.scripts.main)
            resolve(status);
        })
    }

    // ################################################################
    // ###################### PRIVATE FUNCTIONS #######################

    protected send(data: ScriptsReq) {
        super.send(data);
    }
}