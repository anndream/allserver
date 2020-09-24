function isPlainObject(input) {
    return input && input.constructor === Object;
}

module.exports = require("stampit")({
    name: "GrpcTransport",

    props: {
        _fs: require("fs"),
        _grpc: require("@grpc/grpc-js"),
        _protoLoader: require("@grpc/proto-loader"),
        port: process.env.PORT,
        protoFile: null,
        protoFileContents: null,
        options: null,
    },

    init({ port, protoFile, options }) {
        if (port) this.port = port;
        if (protoFile) this.protoFile = protoFile;
        if (options) this.options = options;
    },

    methods: {
        _validateResponseTypes(obj, inspectedSet = new Set()) {
            inspectedSet.add(obj); // circle linking protection

            for (const [k, v] of Object.entries(obj)) {
                if (!isPlainObject(v) || inspectedSet.has(obj)) continue;

                // Not sure how long this code would survive in modern fast pace days.
                if (k === "responseType") {
                    let f = v.type.field[0];
                    const successOk = f && f.name === "success" && f.type === "TYPE_BOOL";
                    if (!successOk) throw new Error(`Method ${obj.originalName} must return "bool success = 1"`);

                    f = v.type.field[1];
                    const codeOk = f && f.name === "code" && f.type === "TYPE_STRING";
                    if (!codeOk) throw new Error(`Method ${obj.originalName} must return "string code = 2"`);

                    f = v.type.field[2];
                    const messageOk = f && f.name === "message" && f.type === "TYPE_STRING";
                    if (!messageOk) throw new Error(`Method ${obj.originalName} must return "string message = 3"`);
                } else {
                    this._validateResponseTypes(v, inspectedSet);
                }
            }
        },

        _validatePackageDefinition(packageDefinition) {
            if (!isPlainObject(packageDefinition)) return;

            if (!packageDefinition.Allserver || !packageDefinition.Allserver.introspect) {
                throw new Error(`Server .proto file is missing Allserver mandatory introspection declarations`);
            }

            this._validateResponseTypes(packageDefinition);
        },

        async startServer(defaultCtx) {
            this.server = new this._grpc.Server(this.options);
            async function wrappedCallback(call, callback) {
                const ctx = { ...defaultCtx, arg: call.request, grpc: { call, callback } };
                await ctx.allserver.handleCall(ctx);
            }

            const packageDefinition = this._protoLoader.loadSync(this.protoFile);
            this._validatePackageDefinition(packageDefinition);

            const protoDescriptor = this._grpc.loadPackageDefinition(packageDefinition);
            for (const typeOfProto of Object.values(protoDescriptor)) {
                if (!(typeof typeOfProto === "function" && isPlainObject(typeOfProto.service))) continue;

                const proxies = { introspect: wrappedCallback };
                for (const [name, impl] of Object.entries(defaultCtx.allserver.procedures)) {
                    if (typeof impl == "function") proxies[name] = wrappedCallback;
                }
                this.server.addService(typeOfProto.service, proxies);
            }

            await new Promise((resolve, reject) => {
                this.server.bindAsync(
                    `0.0.0.0:${this.port}`,
                    this._grpc.ServerCredentials.createInsecure(),
                    (err, result) => (err ? reject(err) : resolve(result))
                );
            });

            return this.server.start();
        },
        stopServer() {
            return new Promise((r) => this.server.tryShutdown(r));
        },

        getProcedureName(ctx) {
            const procedureName = ctx.grpc.call.call.handler.path.split("/").pop();
            if (procedureName === "introspect") return "";
            return procedureName;
        },

        prepareNotFoundReply(ctx) {
            ctx.result = {
                success: false,
                code: "PROCEDURE_NOT_FOUND",
                message: `Procedure ${ctx.procedureName} not found`,
            };
        },
        prepareProcedureErrorReply(ctx) {
            ctx.result = { success: false, code: ctx.error.code || "PROCEDURE_ERROR", message: ctx.error.message };
        },
        async prepareIntrospectionReply(ctx) {
            if (!this.protoFileContents) {
                this.protoFileContents = this._fs.readFileSync(this.protoFile, "utf8");
            }

            ctx.result = {
                success: true,
                code: "OK",
                message: "Introspection as JSON string",
                procedures: JSON.stringify(ctx.introspection),
                proto: this.protoFileContents,
            };
        },

        reply(ctx) {
            ctx.grpc.callback(null, ctx.result);
        },
    },
});
