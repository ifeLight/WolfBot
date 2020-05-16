import * as utils from "@ekliptor/apputils";
import {serverConfig} from "@ekliptor/bit-models";
import * as path from "path";
import * as fs from "fs";
const DEST_DIR = path.join(utils.appDir, '..', 'deploy') + path.sep

const argv = require('minimist')(process.argv.slice(2));
const logger = utils.logger;
const nconf = utils.nconf
const updater = require("@ekliptor/packed-updater");
import {AbstractAdvisor} from "./AbstractAdvisor";
import {TradeConfig} from "./Trade/TradeConfig";

updater.setLogger(logger)

/**
 * Run the updater
 * @param callback() an optional callback that will be called if the app is ready (latest version)
 */
export function runUpdater(callback) {
    if (process.env.IS_CHILD)
        return callback && callback() // nothing to do

    if (argv.bundle === true) {
        const settings = require(path.join(DEST_DIR, 'UpdateSettings.js')); // will only exist on dev machines
        let updateOptions = {
            srcPath: utils.appDir,
            bundleDestDir: DEST_DIR,
            enforceModuleVersions: {
                "mkdirp": "^0.5.1" // fix for tar-fs
            },
            uploadSettings: settings.set.uploadSettings,
            ignorePaths: [
                path.join(utils.appDir, 'docs'),
                path.join(utils.appDir, 'temp'),
                path.join(utils.appDir, 'trades'),
                path.join(utils.appDir, 'public','temp'),
                path.join(utils.appDir, 'public', 'js', 'build'),
                path.join(utils.appDir, 'public', 'js', 'classes'),
                path.join(utils.appDir, 'public', 'js', 'controllers'),
                path.join(utils.appDir, 'public', 'js', 'types'),
                path.join(utils.appDir, 'public', 'js', 'utils'),
                path.join(utils.appDir, 'public', 'js', 'routes.'),
                path.join(utils.appDir, 'public', 'js', 'index.'),

                path.join(utils.appDir, 'bfg.jar'),

                TradeConfig.getConfigBackupRootDir()
                // .json config files don't get bundled because they only exist within the /build dir
            ]
        }
        updater.createBundle(updateOptions, (err, bundle) => {
            if (err)
                logger.error('Error creating update bundle', err)
            else
                logger.log('Created update bundle', bundle)
            process.exit(0)
        })
        return
    }
    else if (nconf.get('debug') === true || argv.debug === true) // don't update debug environment
        return callback && callback()

    let updateOptions = {
        srcPath: utils.appDir,
        updateJsonUrl: nconf.get('updateUrl'),
        download: true
    }
    updater.checkUpdates(updateOptions, async (err, bundle) => {
        if (err) {
            logger.error('Error checking for updates', err)
            return callback && callback() // continue with current version
        }
        else if (bundle && bundle.newVersion === true) {
            let installOptions = {
                srcPath: utils.appDir,
                bundle: bundle
            }
            await prepareConfigBackup(); // updater will overwrite config. restore it afterwards
            await removeFilesBeforeUpdate();
            updater.installUpdate(installOptions, (err) => {
                if (err)
                    logger.error('Error installing update', err)
                process.exit(1) // this callback won't be reached if the update was installed
            })
        }
        else {
            let name = bundle && bundle.name ? bundle.name : 'unknown'
            logger.info(name + ' version is up to date')
            callback && callback()
        }
    })
}

async function prepareConfigBackup() {
    if (nconf.get("serverConfig:premium") !== true)
        return; // always overwrite configs in developer instances
    // the parameter is to create backups of user configs. // TODO what if the user modified original sample configs (which maybe he shouldn't?)
    await AbstractAdvisor.backupOriginalConfig(nconf.get("serverConfig:userConfigs"));
    nconf.set("serverConfig:user:restoreCfg", true);
    await serverConfig.saveConfigLocal();
}

async function removeFilesBeforeUpdate() {
    /*
    let removeOp = new Promise((resolve, reject) => {
        let talibPath = path.join(utils.appDir, "node_modules", "talib"); // must be recompiled after updating nodejs version // TODO detect nodejs version update or remove later
        utils.file.removeFolder(talibPath, (err) => {
            if (err)
                logger.error("Error removing files before update", err);
            resolve();
        });
    });
    await removeOp;
     */
}
