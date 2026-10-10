import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string, createDefaultDirectory: boolean) {
	if (path !== ":memory:") {
		if (createDefaultDirectory) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			chmodSync(dirname(path), 0o700);
		} else if (
			existsSync(dirname(path)) &&
			statSync(dirname(path)).mode & 0o077
		) {
			throw new Error("Custom database directory must be private (mode 0700)");
		}
	}
	if (existsSync(path) && !(statSync(path).mode & 0o222))
		throw new Error("Database is read-only");
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		if (version === 0 && tables.length === 0) {
			db.exec("BEGIN");
			try {
				db.exec(`
                CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
                CREATE TABLE folders (project_id INTEGER NOT NULL REFERENCES projects(id), path TEXT NOT NULL, PRIMARY KEY(project_id,path));
                CREATE TABLE chats (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), model_id TEXT REFERENCES managed_models(id) ON DELETE SET NULL, reasoning_effort TEXT);
                CREATE TABLE agents (id INTEGER PRIMARY KEY, chat_id INTEGER REFERENCES chats(id), prompt TEXT, created_by_tool_call_id INTEGER UNIQUE REFERENCES tool_calls(id), status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','cancelled')), created_at INTEGER NOT NULL, error_code TEXT, CHECK((chat_id IS NOT NULL AND prompt IS NOT NULL AND created_by_tool_call_id IS NULL) OR (chat_id IS NULL AND prompt IS NULL AND created_by_tool_call_id IS NOT NULL)));
                CREATE TABLE model_calls (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(id), url TEXT NOT NULL, method TEXT NOT NULL, requested_at TEXT NOT NULL, request_body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), http_status INTEGER, response_body TEXT, duration_ms INTEGER, error TEXT, error_code TEXT, output_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(output_json) AND json_type(output_json)='array'));
                CREATE TABLE managed_models (id TEXT PRIMARY KEY CHECK(length(trim(id))>0), name TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)));
                CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, model_call_id INTEGER NOT NULL REFERENCES model_calls(id), call_id TEXT NOT NULL, name TEXT NOT NULL, arguments TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','running','succeeded','failed','not_executed','interrupted')), result TEXT, reason TEXT, approval TEXT CHECK(approval IS NULL OR json_valid(approval)), UNIQUE(model_call_id,ordinal));
                CREATE TABLE tool_output (tool_call_id INTEGER NOT NULL REFERENCES tool_calls(id), ordinal INTEGER NOT NULL, stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')), text TEXT NOT NULL, data TEXT NOT NULL DEFAULT '', byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0), PRIMARY KEY(tool_call_id,ordinal));
                CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), sidebar_width REAL NOT NULL DEFAULT 320 CHECK(sidebar_width BETWEEN 240 AND 600), language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','zh-CN')), api_key TEXT, default_model_id TEXT REFERENCES managed_models(id) ON DELETE SET NULL, enter_behavior TEXT NOT NULL DEFAULT 'send' CHECK(enter_behavior IN ('send','newline')), model_call_limit INTEGER NOT NULL DEFAULT 16 CHECK(typeof(model_call_limit)='integer' AND model_call_limit>0), sub_agent_limit INTEGER NOT NULL DEFAULT 32 CHECK(typeof(sub_agent_limit)='integer' AND sub_agent_limit>0));
                INSERT INTO settings(id) VALUES(1);
                PRAGMA user_version=17;
                COMMIT;
            `);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} else if (
			version !== 17 ||
			tables.join(",") !==
				"agents,chats,folders,managed_models,model_calls,projects,settings,tool_calls,tool_output"
		) {
			throw new Error("Unknown database schema");
		}
		const columns = (table: string) =>
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name)
				.join(",");
		for (const [table, expected] of Object.entries({
			projects: "id,name,created_at,archived",
			folders: "project_id,path",
			chats: "id,project_id,name,created_at,archived,model_id,reasoning_effort",
			agents:
				"id,chat_id,prompt,created_by_tool_call_id,status,created_at,error_code",
			model_calls:
				"id,agent_id,url,method,requested_at,request_body,status,http_status,response_body,duration_ms,error,error_code,output_json",
			settings:
				"id,sidebar_width,language,api_key,default_model_id,enter_behavior,model_call_limit,sub_agent_limit",
			managed_models: "id,name,metadata",
			tool_output: "tool_call_id,ordinal,stream,text,data,byte_count",
			tool_calls:
				"id,model_call_id,call_id,name,arguments,ordinal,status,result,reason,approval",
		})) {
			if (columns(table) !== expected)
				throw new Error("Invalid database schema");
		}
		if (
			db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
			db.prepare("PRAGMA foreign_key_check").all().length ||
			db.prepare("SELECT COUNT(*)=1 AND MIN(id)=1 AS valid FROM settings").get()
				?.valid !== 1 ||
			!["en", "zh-CN"].includes(
				String(
					db.prepare("SELECT language FROM settings WHERE id=1").get()
						?.language,
				),
			)
		)
			throw new Error("Corrupt database");

		if (
			!["send", "newline"].includes(
				String(
					db.prepare("SELECT enter_behavior FROM settings WHERE id=1").get()
						?.enter_behavior,
				),
			)
		)
			throw new Error("Corrupt database");

		if (path !== ":memory:") {
			chmodSync(path, 0o600);
		}

		db.exec(
			"SAVEPOINT startup_check; INSERT INTO projects(name,created_at) VALUES ('startup',0); ROLLBACK TO startup_check; RELEASE startup_check;",
		);
		db.exec(`BEGIN;
        UPDATE agents SET status='failed',error_code='agentInterrupted' WHERE status='pending';
        UPDATE tool_calls SET status='interrupted',reason='toolRestartInterrupted',approval=CASE WHEN json_extract(approval,'$.status')='pending' THEN json_set(approval,'$.status','interrupted') ELSE approval END WHERE status IN ('waiting','running');
        UPDATE model_calls SET status='failed',error_code='modelInterrupted',error='Service restarted before the call completed' WHERE status='pending';
        COMMIT;`);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function listProjects(db: DatabaseSync) {
	return db
		.prepare(
			"SELECT id, name, archived, created_at AS createdAt FROM projects ORDER BY COALESCE((SELECT MAX(COALESCE((SELECT MAX(created_at) FROM agents WHERE chat_id=chats.id), created_at)) FROM chats WHERE project_id = projects.id), created_at) DESC, id DESC",
		)
		.all()
		.map((project) => ({
			id: Number(project.id),
			name: String(project.name),
			archived: Boolean(project.archived),
			createdAt: Number(project.createdAt),
			folders: db
				.prepare("SELECT path FROM folders WHERE project_id = ? ORDER BY rowid")
				.all(project.id)
				.map((row) => row.path),
			chats: db
				.prepare(
					"SELECT id, name, archived, created_at AS createdAt, (SELECT MAX(created_at) FROM agents WHERE chat_id=chats.id) AS lastQuestionAt FROM chats WHERE project_id = ? ORDER BY COALESCE((SELECT MAX(created_at) FROM agents WHERE chat_id=chats.id), created_at) DESC, id DESC",
				)
				.all(project.id)
				.map((chat) => ({
					...chat,
					id: Number(chat.id),
					archived: Boolean(chat.archived),
				})),
		}));
}
