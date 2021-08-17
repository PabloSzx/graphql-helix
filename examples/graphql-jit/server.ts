import express from "express";
import { parse, validate } from "graphql";
import {
  getGraphQLParameters,
  processRequest,
  shouldRenderGraphiQL,
} from "graphql-helix";
import { renderGraphiQL } from "@graphql-helix/graphiql";
import { compileQuery, isCompiledQuery } from "graphql-jit";
import lru from "tiny-lru";
import { schema } from "./schema";

const cache = lru(1000, 3600000);

const app = express();

app.use(express.json());

app.use("/graphql", async (req, res) => {
  const request = {
    body: req.body,
    headers: req.headers,
    method: req.method,
    query: req.query,
  };

  if (shouldRenderGraphiQL(request)) {
    res.send(renderGraphiQL());
  } else {
    const { operationName, query, variables } = getGraphQLParameters(request);
    const cacheKey = query || "";
    const cached = cache.get(cacheKey);
    let compiledQuery = cached?.compiledQuery;
    let document = cached?.document;
    let validationErrors = cached?.validationErrors;
    console.log({ cached, compiledQuery, document, validationErrors });

    const result = await processRequest({
      operationName,
      query,
      variables,
      request,
      schema,
      parse: (source, options) => {
        if (!document) {
          document = parse(source, options);
          cache.set(cacheKey, { document });
        }

        return document;
      },
      validate: (schema, documentAST, rules, typeInfo, options) => {
        if (!validationErrors) {
          validationErrors = validate(
            schema,
            documentAST,
            rules,
            typeInfo,
            options
          );
          cache.set(cacheKey, { document, validationErrors });
        }

        return validationErrors;
      },
      execute: (
        schema,
        documentAst,
        rootValue,
        contextValue,
        variableValues,
        operationName
      ) => {
        if (!compiledQuery) {
          compiledQuery = compileQuery(schema, documentAst, operationName);
          cache.set(cacheKey, { compiledQuery, document, validationErrors });
        }

        if (isCompiledQuery(compiledQuery)) {
          return compiledQuery.query(
            rootValue,
            contextValue,
            variableValues || {}
          );
        } else {
          return compiledQuery;
        }
      },
    });

    if (result.type === "RESPONSE") {
      result.headers.forEach(({ name, value }) => res.setHeader(name, value));
      res.status(result.status);
      res.json(result.payload);
    } else if (result.type === "PUSH") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
      });

      req.on("close", () => {
        result.unsubscribe();
      });

      await result.subscribe((result) => {
        res.write(`data: ${JSON.stringify(result)}\n\n`);
      });
    } else {
      // GraphQL JIT does not currently support @defer and @stream
    }
  }
});

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`GraphQL server is running on port ${port}.`);
});
