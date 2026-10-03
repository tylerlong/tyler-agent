import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string, createDefaultDirectory: boolean) {
	if (createDefaultDirectory) mkdirSync(dirname(path), { recursive: true });
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
                CREATE TABLE chats (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL, last_question_at INTEGER, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
                CREATE TABLE turns (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id), user_content TEXT NOT NULL, assistant_content TEXT, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), created_at INTEGER NOT NULL, error_code TEXT, error_details TEXT, output_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(output_json) AND json_type(output_json)='array'));
                CREATE TABLE model_calls (id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL REFERENCES turns(id), url TEXT NOT NULL, method TEXT NOT NULL, requested_at TEXT NOT NULL, request_body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), http_status INTEGER, response_body TEXT, duration_ms INTEGER, error TEXT);
                CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), sidebar_width REAL NOT NULL DEFAULT 320 CHECK(sidebar_width BETWEEN 240 AND 600), language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','zh-CN')));
                INSERT INTO settings(id) VALUES(1);
                PRAGMA user_version=8;
                COMMIT;
            `);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} else if (
			version !== 8 ||
			tables.join(",") !== "chats,folders,model_calls,projects,settings,turns"
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
			chats: "id,project_id,name,created_at,last_question_at,archived",
			turns:
				"id,chat_id,user_content,assistant_content,status,created_at,error_code,error_details,output_json",
			model_calls:
				"id,turn_id,url,method,requested_at,request_body,status,http_status,response_body,duration_ms,error",
			settings: "id,sidebar_width,language",
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
		db.exec(
			"SAVEPOINT startup_check; INSERT INTO projects(name,created_at) VALUES ('startup',0); ROLLBACK TO startup_check; RELEASE startup_check;",
		);
		db.exec(`BEGIN;
        UPDATE turns SET status='failed',error_code='modelInterrupted' WHERE status='pending';
        UPDATE model_calls SET status='failed',error='Service restarted before the call completed' WHERE status='pending';
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
			"SELECT id, name, archived, created_at AS createdAt FROM projects ORDER BY COALESCE((SELECT MAX(COALESCE(last_question_at, created_at)) FROM chats WHERE project_id = projects.id), created_at) DESC, id DESC",
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
					"SELECT id, name, archived, created_at AS createdAt, last_question_at AS lastQuestionAt FROM chats WHERE project_id = ? ORDER BY COALESCE(last_question_at, created_at) DESC, id DESC",
				)
				.all(project.id)
				.map((chat) => ({
					...chat,
					id: Number(chat.id),
					archived: Boolean(chat.archived),
				})),
		}));
}
