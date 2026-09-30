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
			(version !== 1 && version !== 2) ||
			tables.join(",") !==
				(version === 2
					? "chats,folders,projects,sidebar_width,turns"
					: "chats,folders,projects,turns")
		) {
			throw new Error("Unknown database schema");
		}
		if (version === 0) version = 1;
		if (
			columns("projects") !== "id,name,created_at" ||
			columns("folders") !== "project_id,path" ||
			columns("chats") !== "id,project_id,name,created_at,last_question_at" ||
			columns("turns") !== "id,chat_id,user_content,assistant_content"
		)
			throw new Error("Invalid database schema");
		if (version === 2 && columns("sidebar_width") !== "id,width")
			throw new Error("Invalid database schema");
		if (
			db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
			db.prepare("PRAGMA foreign_key_check").all().length
		)
			throw new Error("Corrupt database");
		db.exec(
			`SAVEPOINT startup_check; INSERT INTO projects(name,created_at) VALUES ('startup',0); ROLLBACK TO startup_check; RELEASE startup_check;`,
		);
		if (version === 1) {
			db.exec("BEGIN");
			try {
				db.exec(`
     CREATE TABLE sidebar_width (id INTEGER PRIMARY KEY CHECK(id=1), width REAL NOT NULL CHECK(width BETWEEN 240 AND 600));
     PRAGMA user_version = 2;
     COMMIT;
    `);
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function listProjects(db: DatabaseSync) {
	return db
		.prepare(
			"SELECT id, name, created_at AS createdAt FROM projects ORDER BY COALESCE((SELECT MAX(COALESCE(last_question_at, created_at)) FROM chats WHERE project_id = projects.id), created_at) DESC, id DESC",
		)
		.all()
		.map((project) => ({
			id: Number(project.id),
			name: String(project.name),
			createdAt: Number(project.createdAt),
			folders: db
				.prepare("SELECT path FROM folders WHERE project_id = ? ORDER BY rowid")
				.all(project.id)
				.map((row) => row.path),
			chats: db
				.prepare(
					"SELECT id, name, created_at AS createdAt, last_question_at AS lastQuestionAt FROM chats WHERE project_id = ? ORDER BY COALESCE(last_question_at, created_at) DESC, id DESC",
				)
				.all(project.id),
		}));
}
