// GraphQL schema introspection: fetched on demand per request, kept in memory for the session.
import { buildClientSchema, getIntrospectionQuery, type GraphQLSchema } from "graphql";
import { create } from "zustand";

export interface SchemaState {
  schema?: GraphQLSchema;
  loading?: boolean;
  error?: string;
  fetchedAt?: number;
  /** Resolved URL the schema came from. */
  url?: string;
}

/** Keyed by request id (the tab's draft id). */
export const useSchemas = create<Record<string, SchemaState>>(() => ({}));

export const setSchemaState = (requestId: string, s: SchemaState) => useSchemas.setState({ [requestId]: s });

export const INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });

/** Turn an introspection response body into a schema, with a readable error when it isn't one. */
export function schemaFromResponse(bodyText: string): GraphQLSchema {
  let json: any;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("The server didn't return JSON");
  }
  if (json?.errors?.length && !json?.data?.__schema) {
    throw new Error(`Introspection failed: ${json.errors.map((e: any) => e.message ?? String(e)).join("; ")}`);
  }
  const data = json?.data ?? json;
  if (!data?.__schema) throw new Error("The response has no data.__schema (is introspection disabled on this server?)");
  return buildClientSchema(data);
}
