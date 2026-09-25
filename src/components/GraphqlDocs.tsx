// Schema explorer for GraphQL requests: root operations → fields → types, with a back stack.
import {
  getNamedType, isEnumType, isInputObjectType, isInterfaceType, isObjectType, isUnionType,
  type GraphQLField, type GraphQLInputField, type GraphQLNamedType, type GraphQLSchema, type GraphQLType,
} from "graphql";
import { useMemo, useState } from "react";
import { Icon, IconButton } from "./ui";

function TypeLink({ type, go }: { type: GraphQLType; go: (name: string) => void }) {
  const named = getNamedType(type);
  return <button className="gql-type" onClick={() => go(named.name)}>{type.toString()}</button>;
}

export function GraphqlDocs({ schema, onClose }: { schema: GraphQLSchema; onClose: () => void }) {
  const [stack, setStack] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const current = stack.length ? schema.getType(stack[stack.length - 1]) : undefined;
  const go = (name: string) => { setStack((s) => [...s, name]); setQ(""); };

  const roots = [
    ["Query", schema.getQueryType()],
    ["Mutation", schema.getMutationType()],
    ["Subscription", schema.getSubscriptionType()],
  ].filter(([, t]) => t) as [string, GraphQLNamedType][];

  const allTypes = useMemo(
    () => Object.values(schema.getTypeMap()).filter((t) => !t.name.startsWith("__")).sort((a, b) => a.name.localeCompare(b.name)),
    [schema],
  );

  return (
    <div className="gql-docs">
      <div className="gql-docs-head">
        {stack.length > 0 && <IconButton icon="chevronRight" className="gql-back" title="Back" onClick={() => setStack((s) => s.slice(0, -1))} />}
        <span className="gql-docs-title ellipsis">{current ? current.name : "Schema"}</span>
        <div className="flex-1" />
        <IconButton icon="close" title="Close docs" onClick={onClose} />
      </div>
      <div className="search-box gql-search">
        <Icon name="search" size={12} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={current ? "Filter fields" : "Search types"} />
      </div>
      <div className="gql-docs-body">
        {!current ? (
          q ? (
            allTypes.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())).map((t) => (
              <div key={t.name} className="gql-row"><button className="gql-type" onClick={() => go(t.name)}>{t.name}</button></div>
            ))
          ) : (
            <>
              <div className="gql-section">Root types</div>
              {roots.map(([label, t]) => (
                <div key={label} className="gql-row"><span className="gql-field">{label.toLowerCase()}</span>: <button className="gql-type" onClick={() => go(t.name)}>{t.name}</button></div>
              ))}
              <div className="gql-section">All types</div>
              {allTypes.map((t) => <div key={t.name} className="gql-row"><button className="gql-type" onClick={() => go(t.name)}>{t.name}</button></div>)}
            </>
          )
        ) : (
          <TypeDetail type={current} filter={q} go={go} />
        )}
      </div>
    </div>
  );
}

function TypeDetail({ type, filter, go }: { type: GraphQLNamedType; filter: string; go: (n: string) => void }) {
  const f = filter.toLowerCase();
  const kind = isObjectType(type) ? "type" : isInterfaceType(type) ? "interface" : isInputObjectType(type) ? "input" : isEnumType(type) ? "enum" : isUnionType(type) ? "union" : "scalar";
  const fields: (GraphQLField<unknown, unknown> | GraphQLInputField)[] =
    isObjectType(type) || isInterfaceType(type) || isInputObjectType(type) ? Object.values(type.getFields()) : [];
  return (
    <>
      <div className="gql-kind">{kind}</div>
      {type.description && <p className="gql-desc">{type.description}</p>}
      {fields.length > 0 && <div className="gql-section">Fields</div>}
      {fields.filter((x) => !f || x.name.toLowerCase().includes(f)).map((x) => (
        <div key={x.name} className="gql-field-row">
          <div>
            <span className="gql-field">{x.name}</span>
            {"args" in x && x.args.length > 0 && (
              <span className="gql-args">({x.args.map((a, i) => <span key={a.name}>{i ? ", " : ""}{a.name}: <TypeLink type={a.type} go={go} /></span>)})</span>
            )}
            : <TypeLink type={x.type} go={go} />
            {"deprecationReason" in x && x.deprecationReason && <span className="gql-deprecated" title={x.deprecationReason}>deprecated</span>}
          </div>
          {x.description && <div className="gql-desc">{x.description}</div>}
        </div>
      ))}
      {isEnumType(type) && (
        <>
          <div className="gql-section">Values</div>
          {type.getValues().map((v) => <div key={v.name} className="gql-field-row"><span className="gql-field">{v.name}</span>{v.description && <div className="gql-desc">{v.description}</div>}</div>)}
        </>
      )}
      {isUnionType(type) && (
        <>
          <div className="gql-section">Possible types</div>
          {type.getTypes().map((t) => <div key={t.name} className="gql-row"><button className="gql-type" onClick={() => go(t.name)}>{t.name}</button></div>)}
        </>
      )}
    </>
  );
}
