import crypto from "crypto";
import firebase from "firebase/app";
import "firebase/auth";
import fs from "fs";
import request from "request-promise-native";
import vscode from "vscode";

function md5Hash(path: string) {
    return new Promise((resolve, reject) => {
        const file = fs.createReadStream(path);
        const hash = crypto.createHash("md5");

        file.on("error", err => {
            reject(err);
        });

        hash.once("readable", () => {
            resolve(hash.read().toString("hex"));
        });

        file.pipe(hash);
    });
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand("extension.updateProject", async () => {
        const userJsonFile = await vscode.workspace.findFiles("**/user.json", "", 1);
        const configFile = await vscode.workspace.findFiles("**/config.json", "", 1);

        if (userJsonFile.length === 0) {
            // Request the user to obtain a user file
            await vscode.window.showErrorMessage("Please obtain and add your user.json file in your workspace");
            await vscode.env.openExternal(vscode.Uri.parse("https://apollo.gamesolutionslab.com/login?saveAsFile=1"));
        } else if (configFile.length === 0) {
            // Request the user to obtain a config file
            await vscode.window.showErrorMessage("Please add a config.json file in your workspace");
        } else {
            const userJson = JSON.parse((await vscode.workspace.fs.readFile(userJsonFile[0])).toString());
            const config = JSON.parse((await vscode.workspace.fs.readFile(configFile[0])).toString());

            // Log in
            const user = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
            const idToken = await user.getIdToken();

            // Search assets
            const assets = await vscode.workspace.findFiles("assets/**");

            await Promise.all(assets.map(async asset => {
                const key = asset.path.slice(asset.path.lastIndexOf("/") + 1);

                const localHash = await md5Hash(asset.fsPath);
                let serverHash = "";

                try {
                    // Retrieve hash from server
                    serverHash = await request({
                        method: "POST",
                        uri: config.backendUrl + "/designer/checksum",
                        headers: {
                            Authorization: "Bearer " + idToken
                        },
                        body: {
                            projectId: config.projectId,
                            key
                        },
                        json: true
                    });
                    // tslint:disable-next-line: no-empty
                } catch (e) { }

                if (serverHash !== localHash) {
                    try {
                        // Send content to server
                        await request({
                            method: "POST",
                            uri: config.backendUrl + "/designer/updateContent",
                            qs: {
                                projectId: config.projectId,
                                key
                            },
                            headers: {
                                Authorization: "Bearer " + idToken
                            },
                            formData: {
                                file: fs.createReadStream(asset.fsPath)
                            },
                            json: true
                        });
                    } catch (e) {
                        vscode.window.showErrorMessage(e.error.error);
                    }
                }
            }));

            // Search source files
            const sourceFiles = await vscode.workspace.findFiles("**/*.scl");

            // Aggregate files
            const content = (await Promise.all(sourceFiles.map(async file => (await vscode.workspace.fs.readFile(file)).toString()))).join("\n");

            try {
                // Send content to server
                await request({
                    method: "POST",
                    uri: config.backendUrl + "/editor/updateProject",
                    headers: {
                        Authorization: "Bearer " + idToken
                    },
                    body: {
                        projectId: config.projectId,
                        content
                    },
                    json: true
                });
            } catch (e) {
                vscode.window.showErrorMessage(e.error.error);
            }
        }
    }));
}
