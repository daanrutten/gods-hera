import crypto from "crypto";
import css from "css";
import firebase from "firebase/app";
import "firebase/auth";
import fs from "fs";
import parse5, { DefaultTreeDocument as DTD, DefaultTreeElement as DTE } from "parse5";
import request from "request-promise-native";
import vscode, { Uri } from "vscode";

async function getConfig(): Promise<[any, any, vscode.Uri]> {
    const userJsonFile = await vscode.workspace.findFiles("**/user.json", "", 1);
    const configFile = await vscode.workspace.findFiles("**/config.json", "", 1);

    if (userJsonFile.length === 0) {
        // Request the user to obtain a user file
        await vscode.window.showErrorMessage("Please obtain and add your user.json file in your workspace");
        await vscode.env.openExternal(vscode.Uri.parse("https://iris.gamesolutionslab.com/login"));
    } else if (configFile.length === 0) {
        // Request the user to obtain a config file
        await vscode.window.showErrorMessage("Please add a config.json file in your workspace");
    } else {
        const userJson = JSON.parse((await vscode.workspace.fs.readFile(userJsonFile[0])).toString());
        const config = JSON.parse((await vscode.workspace.fs.readFile(configFile[0])).toString());

        return [userJson, config, userJsonFile[0]];
    }

    return [undefined, undefined, undefined];
}

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

function htmlToOPL(element: DTE, indent = ""): string {
    let str = `${indent}{"${element.nodeName}"${element.attrs.map(attr => `, '${attr.name}'='${attr.value}'`).join("")}`;

    if (element.childNodes.length === 1 && element.childNodes[0].nodeName === "#text") {
        str += `, html="${(element.childNodes[0] as any).value}"`;
    } else if (element.childNodes.length > 0) {
        str += `, children={\n${element.childNodes.filter(child => child.nodeName !== "#text").map(child => htmlToOPL(child as DTE, indent + "\t")).join(",\n")}\n${indent}}`;
    }

    return str + "}";
}

function htmlToJSON(element: DTE, indent = ""): string {
    let str = `${indent}{"0": "${element.nodeName}"${element.attrs.map(attr => `, "${attr.name}": "${attr.value}"`).join("")}`;

    if (element.childNodes.length === 1 && element.childNodes[0].nodeName === "#text") {
        str += `, "html": "${(element.childNodes[0] as any).value}"`;
    } else if (element.childNodes.length > 0) {
        str += `, "children": {\n${element.childNodes.filter(child => child.nodeName !== "#text").map((child, i) => `"${i}": ${htmlToJSON(child as DTE, indent + "\t")}`).join(",\n")}\n${indent}}`;
    }

    return str + "}";
}

function jsonToOPL(element: any): string {
    switch (typeof element) {
        case "object":
            return element ? `{${Object.entries(element).map(entry => `"${entry[0]}" = ${jsonToOPL(entry[1])}`).join(", ")}}` : "NULL";

        case "string":
            return `"${element}"`;

        case "number":
            return element.toString(10);

        case "boolean":
            return element ? "1" : "0";
    }
}

function jsonToJSON(element: any): string {
    switch (typeof element) {
        case "object":
            return element ? `{${Object.entries(element).map(entry => `"${entry[0]}": ${jsonToJSON(entry[1])}`).join(", ")}}` : "null";

        case "string":
            return `"${element}"`;

        case "number":
            return element.toString(10);

        case "boolean":
            return element ? "1" : "0";
    }
}

function cssToOPL(css: css.Rule | css.KeyFrames): string {
    switch (css.type) {
        case "rule":
            return ruleToOpl(css as css.Rule);

        case "keyframes":
            return keyframesToOpl(css as css.KeyFrames);
    }
}

function ruleToOpl(rule: { selectors?: string[], declarations?: css.Declaration[] }): string {
    return `'${rule.selectors.join(", ").replace(/\./g, "\\.")}' = {${rule.declarations.map((decl: css.Declaration) => `\n\t'${decl.property}' = '${decl.value}'`).join(", ")}\n}`;
}

function keyframesToOpl(anim: css.KeyFrames) {
    return `'@keyframes ${anim.name}' = {${anim.keyframes.map((fr: css.KeyFrame) => `\n${ruleToOpl({ selectors: fr.values, declarations: fr.declarations })}`).join(",")}\n}`;
}

function cssToJSON(css: css.Rule | css.KeyFrames): string {
    switch (css.type) {
        case "rule":
            return ruleToJSON(css as css.Rule);

        case "keyframes":
            return keyframesToJSON(css as css.KeyFrames);
    }
}

function ruleToJSON(rule: { selectors?: string[], declarations?: css.Declaration[] }): string {
    return `"${rule.selectors.join(", ")}": {${rule.declarations.map((decl: css.Declaration) => `\n\t"${decl.property}": "${decl.value}"`).join(", ")}\n}`;
}

function keyframesToJSON(anim: css.KeyFrames) {
    return `"@keyframes ${anim.name}": {${anim.keyframes.map((fr: css.KeyFrame) => `\n${ruleToJSON({ selectors: fr.values, declarations: fr.declarations })}`).join(",")}\n}`;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand("extension.updateSource", async () => {
        const [userJson, config, userJsonFile] = await getConfig();

        if (!userJson || !config) {
            return;
        }

        // Log in
        const user: firebase.User = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
        const idToken = await user.getIdToken();
        vscode.workspace.fs.writeFile(userJsonFile, Buffer.from(JSON.stringify(user)));

        // Search source files
        const sourceFiles = await vscode.workspace.findFiles("**/*.opl");

        // Aggregate files
        const sources = await Promise.all(sourceFiles.map(async file => {
            let source = (await vscode.workspace.fs.readFile(file)).toString();
            let match: RegExpExecArray;

            for (const regex = /import\s*\("(.*?)"\)/gi; match = regex.exec(source);) {
                const path = Uri.file(file.path.slice(0, file.path.lastIndexOf("/") + 1) + match[1]);
                let text = (await vscode.workspace.fs.readFile(path)).toString();

                if (match[1].endsWith(".html")) {
                    // Parse HTML
                    const document = parse5.parse(text) as DTD;
                    const body = (document.childNodes[0] as DTE).childNodes[1] as DTE;

                    // Convert HTML to OPL
                    text = body.childNodes.filter(child => child.nodeName !== "#text").map(child => htmlToJSON(child as DTE)).join("");
                } else if (match[1].endsWith(".json")) {
                    // Parse JSON
                    const document = JSON.parse(text);

                    // Convert JSON to OPL
                    text = jsonToJSON(document);
                } else if (match[1].endsWith(".css")) {
                    // Parse CSS
                    const document = css.parse(text);

                    // Convert CSS to OPL
                    text = "{" + document.stylesheet.rules.map(rule => `${cssToJSON(rule)}`).join(",") + "}";
                } else {
                    throw new Error("Expected HTML, JSON or CSS file in import statement");
                }

                source = `${source.slice(0, match.index)}PARSE(${JSON.stringify(text.replace(/\r?\n/g, ""))})${source.slice(match.index + match[0].length)}`;
            }

            return source;
        }));

        try {
            // Send content to server
            await request({
                method: "POST",
                uri: config.backendUrl + "/auth/editor/updateProject",
                headers: {
                    Authorization: "Bearer " + idToken
                },
                body: {
                    projectId: config.projectId,
                    content: sources.reduce((map, source, i) => (map[sourceFiles[i].path] = source, map), {} as Record<string, string>)
                },
                json: true
            });

            vscode.window.showInformationMessage("The source has been succesfully updated");
        } catch (e) {
            const match = /at line (\d+):(\d+)/.exec(e.error.error);

            if (match) {
                let line = parseInt(match[1], 10) - 1;
                const index = parseInt(match[2], 10) - 1;

                let i = 0;
                for (; true; i++) {
                    const lineCount = (sources[i].match(/\n/g) || []).length + 1;

                    if (line >= lineCount) {
                        line -= lineCount;
                    } else {
                        break;
                    }
                }

                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sourceFiles[i].fsPath), { selection: new vscode.Range(line, index, line, index + 1) });
                vscode.window.showErrorMessage(e.error.error.slice(0, match.index) + `at line ${line + 1}:${index + 1}`);
            } else {
                vscode.window.showErrorMessage(e.error.error);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.updateAssets", async () => {
        const [userJson, config, userJsonFile] = await getConfig();

        if (!userJson || !config) {
            return;
        }

        // Log in
        const user: firebase.User = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
        const idToken = await user.getIdToken();
        vscode.workspace.fs.writeFile(userJsonFile, Buffer.from(JSON.stringify(user)));

        // Search assets
        const assets = await vscode.workspace.findFiles("assets/**");

        try {
            await Promise.all(assets.map(async asset => {
                const key = asset.path.slice(asset.path.lastIndexOf("/") + 1);

                const localHash = await md5Hash(asset.fsPath);
                let serverHash = "";

                try {
                    // Retrieve hash from server
                    serverHash = await request({
                        method: "POST",
                        uri: config.backendUrl + "/auth/designer/checksum",
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
                    // Send content to server
                    await request({
                        method: "POST",
                        uri: config.backendUrl + "/auth/designer/updateProject",
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
                }
            }));

            vscode.window.showInformationMessage("The assets have been succesfully updated");
        } catch (e) {
            vscode.window.showErrorMessage(e.error.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.cleanAssets", async () => {
        const [userJson, config, userJsonFile] = await getConfig();

        if (!userJson || !config) {
            return;
        }

        // Log in
        const user: firebase.User = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
        const idToken = await user.getIdToken();
        vscode.workspace.fs.writeFile(userJsonFile, Buffer.from(JSON.stringify(user)));

        try {
            // Retrieve hash from server
            await request({
                method: "POST",
                uri: config.backendUrl + "/auth/designer/cleanProject",
                headers: {
                    Authorization: "Bearer " + idToken
                },
                body: {
                    projectId: config.projectId
                },
                json: true
            });

            vscode.window.showInformationMessage("The assets have been succesfully cleaned");
        } catch (e) {
            vscode.window.showErrorMessage(e.error.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.updateRoles", async () => {
        const [userJson, config, userJsonFile] = await getConfig();
        const rolesFile = await vscode.workspace.findFiles("**/roles.json", "", 1);

        if (!userJson || !config) {
            return;
        } else if (rolesFile.length === 0) {
            // Request the user to add a roles file
            await vscode.window.showErrorMessage("Please add a roles.json file in your workspace");
        } else {
            const roles = JSON.parse((await vscode.workspace.fs.readFile(rolesFile[0])).toString());

            // Log in
            const user: firebase.User = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
            const idToken = await user.getIdToken();
            vscode.workspace.fs.writeFile(userJsonFile, Buffer.from(JSON.stringify(user)));

            try {
                // Send content to server
                await request({
                    method: "POST",
                    uri: config.backendUrl + "/auth/admin/updateProject",
                    headers: {
                        Authorization: "Bearer " + idToken
                    },
                    body: {
                        projectId: config.projectId,
                        roles
                    },
                    json: true
                });

                vscode.window.showInformationMessage("The roles have been succesfully updated");
            } catch (e) {
                vscode.window.showErrorMessage(e.error.error);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.createProject", async () => {
        const [userJson, config, userJsonFile] = await getConfig();

        if (!userJson || !config) {
            return;
        }

        // Log in
        const user: firebase.User = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
        const idToken = await user.getIdToken();
        vscode.workspace.fs.writeFile(userJsonFile, Buffer.from(JSON.stringify(user)));

        try {
            config.name = await vscode.window.showInputBox({ placeHolder: "Name of project" });

            // Send content to server
            config.projectId = await request({
                method: "POST",
                uri: config.backendUrl + "/auth/superadmin/createProject",
                headers: {
                    Authorization: "Bearer " + idToken
                },
                body: {
                    name: config.name
                },
                json: true
            });

            const uri = vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath + "/config.json");
            vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config)));

            vscode.window.showInformationMessage("The project has been succesfully created. Your config file has been updated");
        } catch (e) {
            vscode.window.showErrorMessage(e.error.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerTextEditorCommand("extension.compileHtml", async () => {
        const editor = vscode.window.activeTextEditor;
        const selection = editor && editor.selection;

        if (!editor || selection.isEmpty) {
            vscode.window.showErrorMessage("Please select a snippet of HTML to compile");
            return;
        }

        // Retrieve text from editor
        const text = editor.document.getText(selection);

        // Parse HTML
        const document = parse5.parse(text) as DTD;
        const body = (document.childNodes[0] as DTE).childNodes[1] as DTE;

        // Convert HTML to OPL
        const str = body.childNodes.filter(child => child.nodeName !== "#text").map(child => htmlToOPL(child as DTE)).join("\n");
        await editor.edit(editBuilder => editBuilder.replace(selection, str));
    }));

    context.subscriptions.push(vscode.commands.registerTextEditorCommand("extension.compileJson", async () => {
        const editor = vscode.window.activeTextEditor;
        const selection = editor && editor.selection;

        if (!editor || selection.isEmpty) {
            vscode.window.showErrorMessage("Please select a snippet of JSON to compile");
            return;
        }

        // Retrieve text from editor
        const text = editor.document.getText(selection);

        // Parse JSON
        const document = JSON.parse(text);

        // Convert JSON to OPL
        const str = jsonToOPL(document);
        await editor.edit(editBuilder => editBuilder.replace(selection, str));
    }));

    context.subscriptions.push(vscode.commands.registerTextEditorCommand("extension.compileCss", async () => {
        const editor = vscode.window.activeTextEditor;
        const selection = editor && editor.selection;

        if (!editor || selection.isEmpty) {
            vscode.window.showErrorMessage("Please select a snippet of CSS to compile");
            return;
        }

        // Retrieve text from editor
        const text = editor.document.getText(selection);

        // Parse CSS
        const document = css.parse(text);

        // Convert CSS to OPL
        const str = "{" + document.stylesheet.rules.map(rule => cssToOPL(rule)).join(",\n") + "}";
        await editor.edit(editBuilder => editBuilder.replace(selection, str));
    }));
}
