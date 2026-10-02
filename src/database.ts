import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string, createDefaultDirectory: boolean) {
	if (createDefaultDirectory) mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		let version = db.prepare("PRAGMA user_version").get()?.user_version;
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		const columns = (table: string) =>
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name)
				.join(",");
		const legacy =
			version === 0 &&
			tables.join(",") === "settings,turns" &&
			columns("settings") === "id,folder" &&
			columns("turns") === "id,user_content,assistant_content";
		if (version === 0 && (tables.length === 0 || legacy)) {
			db.exec("BEGIN");
			try {
				if (legacy) db.exec("DROP TABLE settings; DROP TABLE turns;");
				db.exec(`
     CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL);
     CREATE TABLE folders (project_id INTEGER NOT NULL REFERENCES projects(id), path TEXT NOT NULL, PRIMARY KEY(project_id,path));
     CREATE TABLE chats (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at INTEGER NOT NULL, last_question_at INTEGER);
     CREATE TABLE turns (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id), user_content TEXT NOT NULL, assistant_content TEXT NOT NULL);
     PRAGMA user_version = 1;
     COMMIT;
    `);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		} else if (
			(version !== 1 &&
				version !== 2 &&
				version !== 3 &&
				version !== 4 &&
				version !== 5 &&
				version !== 6 &&
				version !== 7) ||
			tables.join(",") !==
				(Number(version) >= 3
					? Number(version) >= 6
						? "chats,folders,model_calls,projects,settings,turns"
						: "chats,folders,projects,settings,turns"
					: version === 2
						? "chats,folders,projects,sidebar_width,turns"
						: "chats,folders,projects,turns")
		) {
			throw new Error("Unknown database schema");
		}
		if (version === 0) version = 1;
		if (
			columns("projects") !==
				`id,name,created_at${Number(version) >= 4 ? ",archived" : ""}` ||
			columns("folders") !== "project_id,path" ||
			columns("chats") !==
				`id,project_id,name,created_at,last_question_at${Number(version) >= 4 ? ",archived" : ""}` ||
			columns("turns") !==
				`id,chat_id,user_content,assistant_content${Number(version) >= 6 ? ",status,created_at,error_code,error_details" : ""}`
		)
			throw new Error("Invalid database schema");
		if (version === 2 && columns("sidebar_width") !== "id,width")
			throw new Error("Invalid database schema");
		if (
			Number(version) >= 3 &&
			columns("settings") !==
				`id,sidebar_width${Number(version) < 7 ? ",debug_enabled" : ""}${Number(version) >= 5 ? ",language" : ""}`
		)
			throw new Error("Invalid database schema");
		if (
			db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
			db.prepare("PRAGMA foreign_key_check").all().length
		)
			throw new Error("Corrupt database");
		if (
			Number(version) >= 3 &&
			db.prepare("SELECT COUNT(*)=1 AND MIN(id)=1 AS valid FROM settings").get()
				?.valid !== 1
		)
			throw new Error("Corrupt database");
		db.exec(
			`SAVEPOINT startup_check; INSERT INTO projects(name,created_at) VALUES ('startup',0); ROLLBACK TO startup_check; RELEASE startup_check;`,
		);
		if (Number(version) < 3) {
			db.exec("BEGIN");
			try {
				db.exec(`
     CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), sidebar_width REAL NOT NULL DEFAULT 320 CHECK(sidebar_width BETWEEN 240 AND 600), debug_enabled INTEGER NOT NULL DEFAULT 1 CHECK(debug_enabled IN (0,1)));
     INSERT INTO settings(id,sidebar_width) VALUES(1,${version === 2 ? "COALESCE((SELECT width FROM sidebar_width WHERE id=1),320)" : "320"});
     ${version === 2 ? "DROP TABLE sidebar_width;" : ""}
     PRAGMA user_version = 3;
     COMMIT;
    `);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (Number(version) < 4) {
			db.exec("BEGIN");
			try {
				db.exec(`
     ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
     ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
     PRAGMA user_version = 4;
     COMMIT;
    `);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (Number(version) < 5) {
			db.exec("BEGIN");
			try {
				db.exec(
					`ALTER TABLE settings ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','zh-CN')); PRAGMA user_version = 5; COMMIT;`,
				);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (
			!["en", "zh-CN"].includes(
				String(
					db.prepare("SELECT language FROM settings WHERE id=1").get()
						?.language,
				),
			)
		)
			throw new Error("Corrupt database");
		if (Number(version) < 6) {
			db.exec("BEGIN");
			try {
				db.exec(`ALTER TABLE turns RENAME TO old_turns;
                CREATE TABLE turns (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id), user_content TEXT NOT NULL, assistant_content TEXT, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), created_at INTEGER NOT NULL, error_code TEXT, error_details TEXT);
                INSERT INTO turns SELECT id,chat_id,user_content,assistant_content,'succeeded',0,NULL,NULL FROM old_turns;
                DROP TABLE old_turns;
                CREATE TABLE model_calls (id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL REFERENCES turns(id), url TEXT NOT NULL, method TEXT NOT NULL, requested_at TEXT NOT NULL, request_body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), http_status INTEGER, response_body TEXT, duration_ms INTEGER, error TEXT);
                PRAGMA user_version=6; COMMIT;`);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (
			columns("model_calls") !==
			"id,turn_id,url,method,requested_at,request_body,status,http_status,response_body,duration_ms,error"
		)
			throw new Error("Invalid database schema");
		if (Number(version) < 7) {
			db.exec("BEGIN");
			try {
				db.exec(
					"ALTER TABLE settings DROP COLUMN debug_enabled; PRAGMA user_version=7; COMMIT;",
				);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
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
