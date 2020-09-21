const { parse: parseUrl, URLSearchParams } = require("url");

module.exports = require("stampit")({
    name: "HttpTransport",

    props: {
        _micro: require("micro"),
        port: process.env.PORT,
    },

    init({ port }) {
        if (port) this.port = port;
    },

    methods: {
        _enrichContext(ctx) {
            ctx.http.url = parseUrl(ctx.http.req.url);

            ctx.http.query = {};
            if (ctx.http.url.query) {
                for (const [key, value] of new URLSearchParams(ctx.http.url.query).entries()) {
                    ctx.http.query[key] = value;
                }
            }
        },

        async _deserializeRequest(ctx) {
            const bodyBuffer = await this._micro.buffer(ctx.http.req);
            let arg = ctx.http.query;
            try {
                // If there is no body we will use request query (aka search params)
                if (bodyBuffer.length !== 0) arg = await this._micro.json(ctx.http.req);
                ctx.arg = arg;
                return true;
            } catch (err) {
                return false;
            }
        },

        async _handleRequest(ctx) {
            if (await this._deserializeRequest(ctx)) {
                await ctx.allserver.handleCall(ctx);
            } else {
                // HTTP protocol request was malformed (not expected structure).
                // We are not going to process it.
                ctx.result = { success: false, code: "BAD_REQUEST", message: "Can't parse JSON" };
                ctx.http.statusCode = 400;
                this.reply(ctx);
            }
        },

        startServer(defaultCtx) {
            this.server = this._micro(async (req, res) => {
                const ctx = { ...defaultCtx, http: { req, res, send: this._micro.send } };
                this._enrichContext(ctx);
                await this._handleRequest(ctx);
            });
            return this.server.listen(this.port);
        },

        getProcedureName(ctx) {
            return ctx.http.url.pathname.substr(1);
        },

        prepareNotFoundReply(ctx) {
            ctx.result = { success: false, code: "NOT_FOUND", message: `Procedure ${ctx.procedureName} not found` };
            ctx.http.statusCode = 404;
        },
        prepareProcedureErrorReply(ctx) {
            ctx.result = { success: false, code: ctx.error.code || "PROCEDURE_ERROR", message: ctx.error.message };
            ctx.http.statusCode = 500;
        },
        prepareIntrospectionReply(ctx) {
            ctx.result = {
                success: true,
                code: "OK",
                message: "Introspection as JSON string",
                procedures: ctx.introspection,
            };
        },

        reply(ctx) {
            if (!ctx.http.statusCode) ctx.http.statusCode = 200;
            ctx.http.send(ctx.http.res, ctx.http.statusCode, ctx.result);
        },
    },
});