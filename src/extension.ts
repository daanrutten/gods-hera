import autoprefixer from "autoprefixer";
import axios from "axios";
import crypto from "crypto";
import firebase from "firebase/app";
import "firebase/auth";
import FormData from "form-data";
import fs from "fs";
import less from "less";
import parse5, { DefaultTreeTextNode, DefaultTreeDocument as DTD, DefaultTreeElement as DTE } from "parse5";
import postcss from "postcss";
import stripJsonComments from "strip-json-comments";
import typescript from "typescript";
import vscode from "vscode";

interface Config {
    backendUrl: string;
    projectId: string;
    name: string;
}

async function login(): Promise<[Config, string]> {
    // Search the user file
    const userJsonFile = await vscode.workspace.findFiles("**/user.json", "**/node_modules/**", 1);

    if (userJsonFile.length === 0) {
        await vscode.window.showErrorMessage("Please obtain and add a user.json file in your workspace");
        await vscode.env.openExternal(vscode.Uri.parse("https://iris.dev.gamesolutionslab.com/login"));

        return [undefined, undefined];
    }

    // Search the config file
    let configFile = await vscode.workspace.findFiles("**/config.json", "**/node_modules/**", 1);

    if (configFile.length === 0) {
        configFile = [vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath + "/config.json")];
        await vscode.workspace.fs.writeFile(configFile[0], Buffer.from(JSON.stringify({ backendUrl: "https://zeus.dev.gamesolutionslab.com" })))
    }

    const userJson = JSON.parse((await vscode.workspace.fs.readFile(userJsonFile[0])).toString());
    const config: Config = JSON.parse((await vscode.workspace.fs.readFile(configFile[0])).toString());

    // Login the user via Firebase
    const user: firebase.User = new (firebase as any).User(userJson, userJson.stsTokenManager, userJson);
    const idToken = await user.getIdToken();
    await vscode.workspace.fs.writeFile(userJsonFile[0], Buffer.from(JSON.stringify(user)));

    return [config, idToken];
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

function htmlToJSON(element: DTE, indent = ""): string {
    let str = `${indent}{"t": "${element.nodeName}"${element.attrs.map(attr => `, "${attr.name}": "${attr.value}"`).join("")}`;

    if (element.childNodes.length === 1 && element.childNodes[0].nodeName === "#text") {
        str += `, "html": "${(element.childNodes[0] as DefaultTreeTextNode).value}"`;
    } else if (element.childNodes.length > 0) {
        str += `, "children": [\n${element.childNodes.filter(child => child.nodeName !== "#text").map(child => htmlToJSON(child as DTE, indent + "\t")).join(",\n")}\n${indent}}`;
    }

    return str + "}";
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand("extension.updateSource", async () => {
        const [config, idToken] = await login();

        if (!config || !idToken) {
            return;
        }

        // Search the tsconfig file
        const tsConfigFile = await vscode.workspace.findFiles("**/tsconfig.json", "**/node_modules/**", 1);

        if (tsConfigFile.length === 0) {
            vscode.window.showErrorMessage("Please add a tsconfig.json file in your workspace");
            return;
        }

        const tsConfig = JSON.parse(stripJsonComments((await vscode.workspace.fs.readFile(tsConfigFile[0])).toString()));

        // Search the source files
        const sourceFiles = await vscode.workspace.findFiles("**/*.ts", "**/node_modules/**");

        // Aggregate files
        const sources = await Promise.all(sourceFiles.map(async file =>
            (await vscode.workspace.fs.readFile(file)).toString()
        ));

        let content: Record<string, string>;

        try {
            content = sources.reduce((map, source, i) => {
                let filename = sourceFiles[i].path.replace(vscode.workspace.workspaceFolders[0].uri.path, ".");
                filename = filename.slice(0, filename.lastIndexOf("."));

                // Transpile typescript to javascript
                const diagnostics: typescript.Diagnostic[] = [];
                map[filename] = typescript.transpile(source, tsConfig.compilerOptions, sourceFiles[i].path, diagnostics);

                if (diagnostics.length > 0) {
                    throw diagnostics[0];
                }

                return map;
            }, {} as Record<string, string>);
        } catch (err) {
            const file = vscode.Uri.file(err.file.fileName);
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file.fsPath), { selection: new vscode.Range(0, err.start, 0, err.start + err.length) });
            vscode.window.showErrorMessage(err.messageText);
            return;
        }

        try {
            // Send the compiled source to server
            await axios.post(config.backendUrl + "/auth/editor/updateProject", {
                projectId: config.projectId,
                content
            }, {
                headers: {
                    Authorization: "Bearer " + idToken
                }
            });

            vscode.window.showInformationMessage("The source has been succesfully updated");
        } catch (err) {
            const match = /^Error: \.(.*?):(\d+)/.exec(err.response.data.error);

            if (match) {
                const file = vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath + match[1] + ".ts");
                const line = parseInt(match[2], 10) - 1;

                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file.fsPath), { selection: new vscode.Range(line, 0, line, 0) });
            }

            vscode.window.showErrorMessage(err.response.data.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.updateAssets", async () => {
        const [config, idToken] = await login();

        if (!config || !idToken) {
            return;
        }

        // Search assets
        const assets = await vscode.workspace.findFiles("assets/**");

        try {
            await Promise.all(assets.map(async asset => {
                const key = asset.path.slice(asset.path.lastIndexOf("/") + 1);
                let serverHash = "";

                try {
                    // Retrieve hash from server
                    serverHash = (await axios.post(config.backendUrl + "/auth/designer/checksum", {
                        projectId: config.projectId,
                        key
                    }, {
                        headers: {
                            Authorization: "Bearer " + idToken
                        },
                    })).data;

                    // eslint-disable-next-line no-empty
                } catch (err) { }

                if (key.endsWith(".less")) {
                    const source = (await vscode.workspace.fs.readFile(asset)).toString();
                    const compiled = await less.render(source, { filename: key, compress: true });
                    const result = await postcss([autoprefixer({ overrideBrowserslist: "> 1%, last 2 versions, not dead" })]).process(compiled.css, { from: asset.fsPath });

                    const localHash = crypto.createHash('md5').update(result.css).digest("hex");

                    if (serverHash !== localHash) {
                        const formData = new FormData();
                        formData.append("file", compiled.css, { filename: key, contentType: "text/css" });

                        // Send the compiled source to server
                        await axios.post(config.backendUrl + "/auth/designer/updateProject", formData, {
                            params: {
                                projectId: config.projectId,
                                key
                            },
                            headers: {
                                ...formData.getHeaders(),
                                Authorization: "Bearer " + idToken
                            },
                        });
                    }
                } else {
                    const localHash = await md5Hash(asset.fsPath);

                    if (serverHash !== localHash) {
                        const formData = new FormData();
                        formData.append("file", fs.createReadStream(asset.fsPath));

                        // Send the asset file to server
                        await axios.post(config.backendUrl + "/auth/designer/updateProject", formData, {
                            params: {
                                projectId: config.projectId,
                                key
                            },
                            headers: {
                                ...formData.getHeaders(),
                                Authorization: "Bearer " + idToken
                            },
                        });
                    }
                }
            }));

            vscode.window.showInformationMessage("The assets have been succesfully updated");
        } catch (err) {
            vscode.window.showErrorMessage(err.response.data.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.cleanAssets", async () => {
        const [config, idToken] = await login();

        if (!config || !idToken) {
            return;
        }

        try {
            // Send request to clean assets
            await axios.post(config.backendUrl + "/auth/designer/cleanProject", {
                projectId: config.projectId
            }, {
                headers: {
                    Authorization: "Bearer " + idToken
                }
            });

            vscode.window.showInformationMessage("The assets have been succesfully cleaned");
        } catch (err) {
            vscode.window.showErrorMessage(err.response.data.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.updateRoles", async () => {
        const [config, idToken] = await login();

        if (!config || !idToken) {
            return;
        }

        // Search the roles json
        const rolesFile = await vscode.workspace.findFiles("**/roles.json", "**/node_modules/**", 1);

        if (rolesFile.length === 0) {
            vscode.window.showErrorMessage("Please add a roles.json file in your workspace");
            return;
        }

        const roles = JSON.parse(stripJsonComments((await vscode.workspace.fs.readFile(rolesFile[0])).toString()));

        try {
            // Send the roles to server
            await axios.post(config.backendUrl + "/auth/admin/updateProject", {
                projectId: config.projectId,
                roles
            }, {
                headers: {
                    Authorization: "Bearer " + idToken
                }
            });

            vscode.window.showInformationMessage("The roles have been succesfully updated");
        } catch (err) {
            vscode.window.showErrorMessage(err.response.data.error);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("extension.createProject", async () => {
        const [config, idToken] = await login();

        if (!config || !idToken) {
            return;
        }

        try {
            config.name = await vscode.window.showInputBox({ placeHolder: "Name of project" });

            // Send the name to server
            config.projectId = (await axios.post(config.backendUrl + "/auth/superadmin/createProject", {
                name: config.name
            }, {
                headers: {
                    Authorization: "Bearer " + idToken
                }
            })).data;

            let uri = vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath + "/config.json");
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(config)));

            uri = vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath + "/tsconfig.json");
            await vscode.workspace.fs.writeFile(uri, Buffer.from(`{
    "compilerOptions": {
        /* Basic Options */
        "target": "ES2015",                       /* Specify ECMAScript target version: 'ES3' (default), 'ES5', 'ES2015', 'ES2016', 'ES2017','ES2018' or 'ESNEXT'. */
        "module": "commonjs",                     /* Specify module code generation: 'none', 'commonjs', 'amd', 'system', 'umd', 'es2015', or 'ESNext'. */
        "skipLibCheck": true,
        "resolveJsonModule": true,
        // "lib": [],                             /* Specify library files to be included in the compilation. */
        // "allowJs": true,                       /* Allow javascript files to be compiled. */
        // "checkJs": true,                       /* Report errors in .js files. */
        // "jsx": "preserve",                     /* Specify JSX code generation: 'preserve', 'react-native', or 'react'. */
        // "declaration": true,                   /* Generates corresponding '.d.ts' file. */
        // "declarationMap": true,                /* Generates a sourcemap for each corresponding '.d.ts' file. */
        // "sourceMap": true,                     /* Generates corresponding '.map' file. */
        // "outFile": "./",                       /* Concatenate and emit output to single file. */
        // "outDir": "dist",                      /* Redirect output structure to the directory. */
        // "rootDir": "./",                       /* Specify the root directory of input files. Use to control the output directory structure with --outDir. */
        // "composite": true,                     /* Enable project compilation */
        "removeComments": true,                   /* Do not emit comments to output. */
        // "noEmit": true,                        /* Do not emit outputs. */
        // "importHelpers": true,                 /* Import emit helpers from 'tslib'. */
        // "downlevelIteration": true,            /* Provide full support for iterables in 'for-of', spread, and destructuring when targeting 'ES5' or 'ES3'. */
        // "isolatedModules": true,               /* Transpile each file as a separate module (similar to 'ts.transpileModule'). */
    
        /* Strict Type-Checking Options */
        // "strict": true,                        /* Enable all strict type-checking options. */
        "noImplicitAny": true,                    /* Raise error on expressions and declarations with an implied 'any' type. */
        // "strictNullChecks": true,              /* Enable strict null checks. */
        // "strictFunctionTypes": true,           /* Enable strict checking of function types. */
        // "strictPropertyInitialization": true,  /* Enable strict checking of property initialization in classes. */
        // "noImplicitThis": true,                /* Raise error on 'this' expressions with an implied 'any' type. */
        // "alwaysStrict": true,                  /* Parse in strict mode and emit "use strict" for each source file. */
    
        /* Additional Checks */
        // "noUnusedLocals": true,                /* Report errors on unused locals. */
        // "noUnusedParameters": true,            /* Report errors on unused parameters. */
        // "noImplicitReturns": true,             /* Report error when not all code paths in function return a value. */
        // "noFallthroughCasesInSwitch": true,    /* Report errors for fallthrough cases in switch statement. */
    
        /* Module Resolution Options */
        "moduleResolution": "node",               /* Specify module resolution strategy: 'node' (Node.js) or 'classic' (TypeScript pre-1.6). */
        // "baseUrl": "./",                       /* Base directory to resolve non-absolute module names. */
        // "paths": {},                           /* A series of entries which re-map imports to lookup locations relative to the 'baseUrl'. */
        // "rootDirs": [],                        /* List of root folders whose combined content represents the structure of the project at runtime. */
        // "typeRoots": [],                       /* List of folders to include type definitions from. */
        // "types": [],                           /* Type declaration files to be included in compilation. */
        // "allowSyntheticDefaultImports": true,  /* Allow default imports from modules with no default export. This does not affect code emit, just typechecking. */
        "esModuleInterop": true,                  /* Enables emit interoperability between CommonJS and ES Modules via creation of namespace objects for all imports. Implies 'allowSyntheticDefaultImports'. */
        // "preserveSymlinks": true,              /* Do not resolve the real path of symlinks. */
    
        /* Source Map Options */
        // "sourceRoot": "",                      /* Specify the location where debugger should locate TypeScript files instead of source locations. */
        // "mapRoot": "",                         /* Specify the location where debugger should locate map files instead of generated locations. */
        // "inlineSourceMap": true,               /* Emit a single file with source maps instead of having a separate file. */
        // "inlineSources": true,                 /* Emit the source alongside the sourcemaps within a single file; requires '--inlineSourceMap' or '--sourceMap' to be set. */
    
        /* Experimental Options */
        "experimentalDecorators": true,           /* Enables experimental support for ES7 decorators. */
        "emitDecoratorMetadata": true,            /* Enables experimental support for emitting type metadata for decorators. */
    
        /* Advanced Options */
        "forceConsistentCasingInFileNames": true  /* Disallow inconsistently-cased references to the same file. */
    }
}`));

            vscode.window.showInformationMessage("The project has been succesfully created. Your config file has been updated");
        } catch (err) {
            vscode.window.showErrorMessage(err.response.data.error);
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
        const str = body.childNodes.filter(child => child.nodeName !== "#text").map(child => htmlToJSON(child as DTE)).join("\n");
        await editor.edit(editBuilder => editBuilder.replace(selection, str));
    }));
}
