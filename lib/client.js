window.__ModuleLoader__.load({
	id: "dsh-remote-ssh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/RemoteFileTree.tsx
		/**
		* Remote file tree for the better-sidebar: a lazy-loaded tree view that browses
		* a remote host over the shared `/dsh-ssh` RPC channel (SFTP). Registered as a
		* better-sidebar tab when the service is available; gracefully absent otherwise.
		*
		* Clicking a file fetches its content and renders it in a preview panel below
		* the tree — text (with basic syntax highlighting), images, or rendered
		* Markdown. Clicking a directory toggles its children.
		*/
		/** Format a byte count for display. */
		function formatSize(bytes) {
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}
		/** Simple MIME type guess from file extension. */
		function mimeFromExt(name) {
			return {
				".txt": "text/plain",
				".md": "text/markdown",
				".json": "application/json",
				".js": "text/javascript",
				".ts": "text/typescript",
				".jsx": "text/javascript",
				".tsx": "text/typescript",
				".css": "text/css",
				".html": "text/html",
				".xml": "text/xml",
				".yaml": "text/yaml",
				".yml": "text/yaml",
				".toml": "text/plain",
				".ini": "text/plain",
				".py": "text/x-python",
				".rb": "text/x-ruby",
				".go": "text/x-go",
				".rs": "text/x-rust",
				".java": "text/x-java",
				".c": "text/x-c",
				".h": "text/x-c",
				".cpp": "text/x-c++",
				".hpp": "text/x-c++",
				".sh": "text/x-shellscript",
				".bash": "text/x-shellscript",
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".gif": "image/gif",
				".webp": "image/webp",
				".svg": "image/svg+xml",
				".ico": "image/x-icon",
				".bmp": "image/bmp",
				".pdf": "application/pdf"
			}[(name.includes(".") ? name.slice(name.lastIndexOf(".")) : "").toLowerCase()] ?? "text/plain";
		}
		/** Detect whether a MIME type is an image. */
		function isImage(mime) {
			return mime.startsWith("image/");
		}
		function renderMarkdown(text) {
			let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => `<pre><code class="${lang}">${code.trim()}</code></pre>`);
			html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
			html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
			html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\" target=\"_blank\">$1</a>");
			html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
			html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
			html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
			html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
			html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
			html = html.replace(/\n\n/g, "</p><p>");
			html = `<p>${html}</p>`;
			return html;
		}
		function Icon({ type, size = 16 }) {
			const paths = {
				folder: "M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z",
				folderOpen: "M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v1H4l1.5 9h15L19 8H5",
				file: "M4 4a2 2 0 012-2h8l4 4v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z",
				symlink: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71",
				broken: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z M12 9v4 M12 17h.01",
				chevron: "M9 18l6-6-6-6",
				refresh: "M1 4v6h6M23 20v-6h-6 M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15",
				home: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
				spinner: "M12 2a10 10 0 1010 10"
			};
			const p = paths[type] ?? paths.file;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: type === "broken" ? "#e5534b" : type === "symlink" ? "#9b6bff" : "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				style: { flexShrink: 0 },
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: p })
			});
		}
		function RemoteFileTree({ rpc, connectionId, home }) {
			const [currentPath, setCurrentPath] = (0, react.useState)(home);
			const [entries, setEntries] = (0, react.useState)([]);
			const [crumbs, setCrumbs] = (0, react.useState)([]);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(null);
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [childCache, setChildCache] = (0, react.useState)(/* @__PURE__ */ new Map());
			const [showHidden, setShowHidden] = (0, react.useState)(false);
			const [selectedFile, setSelectedFile] = (0, react.useState)(null);
			const [fileLoading, setFileLoading] = (0, react.useState)(false);
			const abortRef = (0, react.useRef)(null);
			const fetchListing = (0, react.useCallback)(async (path) => {
				abortRef.current?.abort();
				const ac = new AbortController();
				abortRef.current = ac;
				setLoading(true);
				setError(null);
				try {
					const result = await rpc("browse.listAll", {
						id: connectionId,
						path
					}, ac.signal);
					if (ac.signal.aborted) return;
					if (result.ok) {
						const listing = result.value;
						setEntries(listing.entries);
						setCrumbs(listing.crumbs);
						setCurrentPath(listing.path);
					} else setError(result.error.message);
				} catch (err) {
					if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
				} finally {
					if (!ac.signal.aborted) setLoading(false);
				}
			}, [rpc, connectionId]);
			(0, react.useEffect)(() => {
				fetchListing(home);
				return () => abortRef.current?.abort();
			}, [fetchListing, home]);
			const toggleExpand = (0, react.useCallback)(async (entry) => {
				if (!entry.isDir) return;
				const key = entry.path;
				if (expanded.has(key)) setExpanded((prev) => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
				else {
					setExpanded((prev) => new Set(prev).add(key));
					if (!childCache.has(key)) try {
						const result = await rpc("browse.listAll", {
							id: connectionId,
							path: key
						});
						if (result.ok) {
							const listing = result.value;
							setChildCache((prev) => new Map(prev).set(key, listing.entries));
						}
					} catch {}
				}
			}, [
				expanded,
				childCache,
				rpc,
				connectionId
			]);
			const openFile = (0, react.useCallback)(async (entry) => {
				if (entry.isDir) return toggleExpand(entry);
				setSelectedFile(null);
				setFileLoading(true);
				try {
					const result = await rpc("browse.readFile", {
						id: connectionId,
						path: entry.path
					});
					if (result.ok) {
						const { content, size, mimeType } = result.value;
						setSelectedFile({
							path: entry.path,
							name: entry.name,
							mime: mimeType,
							content,
							size
						});
					}
				} catch (err) {
					setSelectedFile({
						path: entry.path,
						name: entry.name,
						mime: mimeFromExt(entry.name),
						content: "",
						size: 0
					});
				} finally {
					setFileLoading(false);
				}
			}, [
				rpc,
				connectionId,
				toggleExpand
			]);
			const navigateTo = (0, react.useCallback)((path) => {
				if (path === currentPath) return;
				setExpanded(/* @__PURE__ */ new Set());
				setChildCache(/* @__PURE__ */ new Map());
				fetchListing(path);
			}, [currentPath, fetchListing]);
			const filteredEntries = entries.filter((e) => showHidden || !e.hidden);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					fontFamily: "var(--font-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)",
					fontSize: 13,
					color: "var(--color-fg, #e8e9ec)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							padding: "8px 12px",
							borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.08))",
							flexShrink: 0
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => navigateTo(home),
								title: "Home",
								style: {
									background: "none",
									border: "none",
									color: "var(--color-fg-muted, #999)",
									cursor: "pointer",
									padding: 2,
									display: "flex"
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									type: "home",
									size: 15
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 2,
									flex: 1,
									overflow: "hidden",
									fontSize: 12
								},
								children: crumbs.map((crumb, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 2,
										whiteSpace: "nowrap"
									},
									children: [i > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											color: "var(--color-fg-subtle, #666)",
											margin: "0 2px"
										},
										children: "/"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										onClick: () => navigateTo(crumb.path),
										style: {
											background: "none",
											border: "none",
											color: i === crumbs.length - 1 ? "var(--color-fg, #e8e9ec)" : "var(--color-accent, #4a6cf7)",
											cursor: "pointer",
											padding: "1px 4px",
											borderRadius: 4,
											fontSize: 12,
											fontWeight: i === crumbs.length - 1 ? 600 : 400,
											maxWidth: 160,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										},
										children: crumb.name || "/"
									})]
								}, crumb.path))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => setShowHidden((v) => !v),
								title: "Toggle hidden files",
								style: {
									background: "none",
									border: "none",
									color: showHidden ? "var(--color-accent, #4a6cf7)" : "var(--color-fg-muted, #999)",
									cursor: "pointer",
									padding: 2,
									fontSize: 11,
									fontWeight: showHidden ? 600 : 400
								},
								children: ".*"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => fetchListing(currentPath),
								title: "Refresh",
								style: {
									background: "none",
									border: "none",
									color: "var(--color-fg-muted, #999)",
									cursor: "pointer",
									padding: 2,
									display: "flex"
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									type: "refresh",
									size: 14
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: 1,
							overflow: "auto",
							padding: "4px 0"
						},
						children: [
							loading && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									gap: 8,
									padding: 20,
									color: "var(--color-fg-muted, #999)",
									fontSize: 12
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
									type: "spinner",
									size: 14
								}), "Loading..."]
							}),
							error && !loading && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									padding: 12,
									margin: 8,
									borderRadius: 8,
									background: "var(--color-danger-soft, rgba(229,83,75,0.12))",
									border: "1px solid var(--color-danger, rgba(229,83,75,0.28))",
									fontSize: 12
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											color: "var(--color-danger-text, #e5534b)",
											fontWeight: 600,
											marginBottom: 4
										},
										children: "Connection error"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											color: "var(--color-fg-muted, #999)",
											wordBreak: "break-word"
										},
										children: error
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										onClick: () => fetchListing(currentPath),
										style: {
											marginTop: 8,
											padding: "3px 10px",
											borderRadius: 6,
											border: "1px solid var(--color-border, rgba(255,255,255,0.1))",
											background: "var(--color-surface, #1a1b1e)",
											color: "var(--color-fg, #e8e9ec)",
											cursor: "pointer",
											fontSize: 12
										},
										children: "Retry"
									})
								]
							}),
							!loading && !error && filteredEntries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									padding: 24,
									textAlign: "center",
									color: "var(--color-fg-muted, #999)",
									fontSize: 12
								},
								children: "Empty directory"
							}),
							!loading && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 1
								},
								children: filteredEntries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FileTreeRow, {
									entry,
									depth: 0,
									expanded,
									childCache,
									onToggle: toggleExpand,
									onOpen: openFile,
									selectedPath: selectedFile?.path
								}, entry.path))
							}),
							entries.length > 0 && entries.length >= filteredEntries.length && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									padding: "6px 12px",
									color: "var(--color-fg-subtle, #666)",
									fontSize: 11
								},
								children: [
									entries.length,
									" entries",
									showHidden ? "" : " (hidden files hidden)"
								]
							})
						]
					}),
					selectedFile && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							borderTop: "1px solid var(--color-border, rgba(255,255,255,0.08))",
							flexShrink: 0,
							maxHeight: "45%",
							overflow: "auto"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								padding: "6px 12px",
								borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.06))",
								fontSize: 12,
								color: "var(--color-fg-muted, #999)"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontWeight: 600,
										color: "var(--color-fg, #e8e9ec)"
									},
									children: selectedFile.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatSize(selectedFile.size) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									onClick: () => setSelectedFile(null),
									style: {
										background: "none",
										border: "none",
										color: "var(--color-fg-muted, #999)",
										cursor: "pointer",
										fontSize: 16,
										padding: "0 4px"
									},
									children: "✕"
								})
							]
						}), fileLoading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: 20,
								textAlign: "center",
								color: "var(--color-fg-muted, #999)",
								fontSize: 12
							},
							children: "Loading..."
						}) : selectedFile.content === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: 20,
								textAlign: "center",
								color: "var(--color-fg-muted, #999)",
								fontSize: 12
							},
							children: "Empty file or unreadable"
						}) : isImage(selectedFile.mime) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: 12,
								display: "flex",
								justifyContent: "center"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
								src: `data:${selectedFile.mime};base64,${selectedFile.content}`,
								alt: selectedFile.name,
								style: {
									maxWidth: "100%",
									maxHeight: 400,
									objectFit: "contain",
									borderRadius: 6
								}
							})
						}) : selectedFile.mime === "text/markdown" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "12px 16px",
								fontSize: 13,
								lineHeight: 1.7,
								overflow: "auto"
							},
							dangerouslySetInnerHTML: { __html: renderMarkdown(atob(selectedFile.content)) }
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							style: {
								margin: 0,
								padding: "10px 14px",
								fontSize: 12,
								lineHeight: 1.5,
								overflow: "auto",
								fontFamily: "var(--font-mono, ui-monospace, \"SF Mono\", Consolas, monospace)",
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								color: "var(--color-fg, #e8e9ec)"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: atob(selectedFile.content) })
						})]
					})
				]
			});
		}
		function FileTreeRow({ entry, depth, expanded, childCache, onToggle, onOpen, selectedPath }) {
			const isExpanded = expanded.has(entry.path);
			const children = childCache.get(entry.path);
			const isSelected = selectedPath === entry.path;
			const iconType = entry.broken ? "broken" : entry.isSymlink ? "symlink" : entry.isDir ? isExpanded ? "folderOpen" : "folder" : "file";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					onClick: () => onOpen(entry),
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "4px 8px",
						paddingLeft: 8 + depth * 16,
						cursor: "pointer",
						borderRadius: 6,
						margin: "0 4px",
						background: isSelected ? "var(--color-accent-soft, rgba(74,108,247,0.13))" : "transparent",
						opacity: entry.hidden ? .6 : 1,
						userSelect: "none"
					},
					onMouseEnter: (e) => {
						if (!isSelected) e.currentTarget.style.background = "var(--color-surface-3, rgba(255,255,255,0.04))";
					},
					onMouseLeave: (e) => {
						if (!isSelected) e.currentTarget.style.background = "transparent";
					},
					children: [
						entry.isDir && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							onClick: (e) => {
								e.stopPropagation();
								onToggle(entry);
							},
							style: {
								display: "flex",
								transform: isExpanded ? "rotate(90deg)" : "none",
								transition: "transform 0.12s",
								flexShrink: 0
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
								type: "chevron",
								size: 12
							})
						}),
						!entry.isDir && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
							width: 12,
							flexShrink: 0
						} }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Icon, {
							type: iconType,
							size: 15
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								flex: 1,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								fontSize: 13
							},
							children: [entry.name, entry.isSymlink && !entry.isDir && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: "var(--color-fg-subtle, #666)",
									marginLeft: 4,
									fontSize: 11
								},
								children: "→"
							})]
						}),
						!entry.isDir && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								color: "var(--color-fg-subtle, #666)",
								fontSize: 11,
								flexShrink: 0
							},
							children: formatSize(entry.size)
						})
					]
				}),
				entry.isDir && isExpanded && children && children.length > 0 && children.map((child) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FileTreeRow, {
					entry: child,
					depth: depth + 1,
					expanded,
					childCache,
					onToggle,
					onOpen,
					selectedPath
				}, child.path)),
				entry.isDir && isExpanded && children && children.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						paddingLeft: 8 + (depth + 1) * 16 + 20,
						fontSize: 12,
						color: "var(--color-fg-subtle, #666)",
						padding: "4px 0"
					},
					children: "Empty"
				})
			] });
		}
		function RemoteFileBrowser({ rpc }) {
			const [connections, setConnections] = (0, react.useState)([]);
			const [selectedId, setSelectedId] = (0, react.useState)(null);
			const [home, setHome] = (0, react.useState)("/");
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let cancelled = false;
				rpc("connections.list").then((result) => {
					if (cancelled) return;
					if (result.ok) {
						const list = result.value;
						setConnections(list);
						if (list.length === 1) setSelectedId(list[0].id);
					} else setError(result.error.message);
					setLoading(false);
				}).catch((err) => {
					if (!cancelled) {
						setError(err instanceof Error ? err.message : String(err));
						setLoading(false);
					}
				});
				return () => {
					cancelled = true;
				};
			}, [rpc]);
			(0, react.useEffect)(() => {
				if (selectedId === null) return;
				let cancelled = false;
				rpc("browse.home", { id: selectedId }).then((result) => {
					if (cancelled) return;
					if (result.ok) setHome(result.value.path);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [rpc, selectedId]);
			if (loading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					height: "100%",
					color: "var(--color-fg-muted, #999)",
					fontSize: 13
				},
				children: "Loading connections..."
			});
			if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 20,
					textAlign: "center",
					color: "var(--color-fg-muted, #999)",
					fontSize: 13
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						color: "var(--color-danger-text, #e5534b)",
						marginBottom: 8
					},
					children: "Connection error"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: error })]
			});
			if (connections.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					height: "100%",
					gap: 12,
					color: "var(--color-fg-muted, #999)",
					fontSize: 13,
					padding: 24
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 32,
							opacity: .3
						},
						children: "🔌"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: "No saved connections" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { fontSize: 12 },
						children: "Add a remote connection in the workspace picker first"
					})
				]
			});
			if (selectedId === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: "12px 16px",
						fontSize: 13,
						fontWeight: 600,
						borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.08))",
						color: "var(--color-fg, #e8e9ec)"
					},
					children: "Select a remote host"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						flex: 1,
						overflow: "auto"
					},
					children: connections.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						onClick: () => setSelectedId(c.id),
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							width: "100%",
							padding: "10px 16px",
							background: "none",
							border: "none",
							borderBottom: "1px solid var(--color-border, rgba(255,255,255,0.04))",
							color: "var(--color-fg, #e8e9ec)",
							cursor: "pointer",
							fontSize: 13,
							textAlign: "left"
						},
						onMouseEnter: (e) => {
							e.currentTarget.style.background = "var(--color-surface-3, rgba(255,255,255,0.04))";
						},
						onMouseLeave: (e) => {
							e.currentTarget.style.background = "transparent";
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontSize: 18 },
							children: "🖥️"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { flex: 1 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { fontWeight: 600 },
								children: c.label
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 11,
									color: "var(--color-fg-muted, #999)"
								},
								children: [
									c.username,
									"@",
									c.host,
									":",
									c.port
								]
							})]
						})]
					}, c.id))
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RemoteFileTree, {
				rpc,
				connectionId: selectedId,
				home
			});
		}
		//#endregion
		//#region src/client/ui.ts
		/**
		* Shared UI utilities for the dsh-ssh client: a class-name joiner and the
		* dialog behavior every modal reuses — a document-level close stack (Esc
		* always dismisses the topmost dialog only), a Tab focus trap, initial focus,
		* and focus restoration. No external focus-management dependency.
		*/
		/** Join truthy class-name fragments; false/null/undefined drop out. */
		const cx = (...parts) => parts.filter((part) => typeof part === "string" && part !== "").join(" ");
		const FOCUSABLE = [
			"a[href]",
			"button:not([disabled])",
			"input:not([disabled])",
			"select:not([disabled])",
			"textarea:not([disabled])",
			"[tabindex]:not([tabindex=\"-1\"])"
		].join(", ");
		/** Live dialog closers; only the top entry reacts to Esc and Tab. */
		const stack = [];
		/**
		* Dialog accessibility behavior for one modal while `active`.
		* Returns the ref to place on the dialog element.
		*/
		function useDialogA11y(active, onClose) {
			const ref = (0, react.useRef)(null);
			const closeRef = (0, react.useRef)(onClose);
			closeRef.current = onClose;
			(0, react.useEffect)(() => {
				if (!active) return;
				const element = ref.current;
				if (element === null) return;
				const close = () => {
					closeRef.current();
				};
				stack.push(close);
				const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
				const focusables = () => Array.from(element.querySelectorAll(FOCUSABLE)).filter((node) => node.offsetParent !== null);
				element.tabIndex = -1;
				(element.querySelector("input, textarea, select") ?? element).focus();
				const onKeyDown = (event) => {
					if (stack[stack.length - 1] !== close) return;
					if (event.key === "Escape") {
						event.preventDefault();
						close();
						return;
					}
					if (event.key !== "Tab") return;
					const focusable = focusables();
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					if (first === void 0 || last === void 0) {
						event.preventDefault();
						element.focus();
						return;
					}
					const current = document.activeElement;
					const atStart = current === first || current === element || current === document.body || current === null;
					const atEnd = current === last || current === element || current === document.body || current === null;
					if (event.shiftKey && atStart) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && atEnd) {
						event.preventDefault();
						first.focus();
					}
				};
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("keydown", onKeyDown, true);
					const index = stack.lastIndexOf(close);
					if (index >= 0) stack.splice(index, 1);
					if (previous !== null && document.contains(previous)) previous.focus();
				};
			}, [active]);
			return ref;
		}
		//#endregion
		//#region src/client/icons.tsx
		const base = {
			width: 16,
			height: 16,
			viewBox: "0 0 16 16",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": true,
			focusable: "false"
		};
		function FolderIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M1.75 4.75c0-.69.56-1.25 1.25-1.25h3.1c.37 0 .72.16.95.44l.85 1.03h5.35c.69 0 1.25.56 1.25 1.25v6.28c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.75Z" })
			});
		}
		function FolderPlusIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M1.75 4.75c0-.69.56-1.25 1.25-1.25h3.1c.37 0 .72.16.95.44l.85 1.03h5.35c.69 0 1.25.56 1.25 1.25v6.28c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.75Z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 7.25v4M6 9.25h4" })]
			});
		}
		function MonitorIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "1.75",
					y: "2.5",
					width: "12.5",
					height: "8.5",
					rx: "1.25"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 13.5h5M8 11v2.5" })]
			});
		}
		function ServerIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2",
						y: "1.75",
						width: "12",
						height: "5",
						rx: "1.25"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2",
						y: "9.25",
						width: "12",
						height: "5",
						rx: "1.25"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.6 4.25h.01M4.6 11.75h.01" })
				]
			});
		}
		function HomeIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.75 7.25 8 2.5l5.25 4.75" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.25 6.5V13a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V6.5" })]
			});
		}
		function PlusIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 3.25v9.5M3.25 8h9.5" })
			});
		}
		function CloseIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 4l8 8M12 4l-8 8" })
			});
		}
		function RefreshIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.25 8a5.25 5.25 0 1 1-1.54-3.71" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.5 2.75v2.5h-2.5" })]
			});
		}
		function EyeIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "2"
				})]
			});
		}
		function TrashIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.75 4.5h10.5M6.5 4.5V3.25A.75.75 0 0 1 7.25 2.5h1.5a.75.75 0 0 1 .75.75V4.5" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.25 4.5l.5 8a.75.75 0 0 0 .75.7h5a.75.75 0 0 0 .75-.7l.5-8" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.75 7.25v3.5M9.25 7.25v3.5" })
				]
			});
		}
		function ChevronIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.25 3.75 10.5 8l-4.25 4.25" })
			});
		}
		function KeyIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "5",
					cy: "11",
					r: "2.25"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.6 9.4 12.75 3.25M10.75 5.25l1.5 1.5M12.75 3.25l1.5 1.5" })]
			});
		}
		function LockIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "3.25",
					y: "7",
					width: "9.5",
					height: "6.25",
					rx: "1.25"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" })]
			});
		}
		function RouteIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "3.5",
						cy: "12.5",
						r: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "12.5",
						cy: "3.5",
						r: "1.5"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.75 11.25C8 10.5 10.5 8 11.25 4.75" })
				]
			});
		}
		function AlertIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				...base,
				...props,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 2.25 14.5 13.4a.55.55 0 0 1-.48.85H1.98a.55.55 0 0 1-.48-.85L8 2.25Z" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 6.25v3.25M8 11.75h.01" })]
			});
		}
		function CheckIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3 8.6 6.4 12 13 4.5" })
			});
		}
		function SparkIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1.75 9.4 6.1 13.75 7.5 9.4 8.9 8 13.25 6.6 8.9 2.25 7.5 6.6 6.1 8 1.75Z" })
			});
		}
		function SpinnerIcon(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...base,
				...props,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.25 8A5.25 5.25 0 1 1 8 2.75" })
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/ruitongxue/Documents/MyProject/deepseek-harness/packages/remote/ssh-gui/src/client/flow.module.css.mjs
		const css = ".yDo7AG_overlay{--dshssh-accent:var(--color-primary,var(--accent,var(--primary,#4a6cf7)));--dshssh-accent-fg:#fff;--dshssh-surface:var(--color-bg-elevated,var(--background,var(--card,#17181c)));--dshssh-fg:var(--color-fg,var(--foreground,#e8e9ec));--dshssh-danger:var(--color-danger,var(--destructive,#e5534b));--dshssh-success:var(--color-success,var(--success,#3fb950));--dshssh-scrim:#090a0d94;--dshssh-shadow:0 24px 64px #00000080;--dshssh-surface-2:color-mix(in srgb, var(--dshssh-fg) 3%, var(--dshssh-surface));--dshssh-surface-3:color-mix(in srgb, var(--dshssh-fg) 7%, var(--dshssh-surface));--dshssh-surface-inset:color-mix(in srgb, black 10%, var(--dshssh-surface));--dshssh-line:color-mix(in srgb, var(--dshssh-fg) 8%, var(--dshssh-surface));--dshssh-border:color-mix(in srgb, var(--dshssh-fg) 14%, var(--dshssh-surface));--dshssh-border-strong:color-mix(in srgb, var(--dshssh-fg) 26%, var(--dshssh-surface));--dshssh-fg-muted:color-mix(in srgb, var(--dshssh-fg) 60%, var(--dshssh-surface));--dshssh-fg-subtle:color-mix(in srgb, var(--dshssh-fg) 38%, var(--dshssh-surface));--dshssh-accent-soft:color-mix(in srgb, var(--dshssh-accent) 13%, var(--dshssh-surface));--dshssh-danger-soft:color-mix(in srgb, var(--dshssh-danger) 12%, var(--dshssh-surface));--dshssh-success-soft:color-mix(in srgb, var(--dshssh-success) 12%, var(--dshssh-surface));--dshssh-danger-text:color-mix(in srgb, var(--dshssh-danger) 55%, var(--dshssh-fg));--dshssh-success-text:color-mix(in srgb, var(--dshssh-success) 45%, var(--dshssh-fg))}@media (prefers-color-scheme:light){.yDo7AG_overlay{--dshssh-accent:var(--color-primary,var(--accent,var(--primary,#3b5bdb)));--dshssh-surface:var(--color-bg-elevated,var(--background,var(--card,#fff)));--dshssh-fg:var(--color-fg,var(--foreground,#21242a));--dshssh-danger:var(--color-danger,var(--destructive,#c9352f));--dshssh-success:var(--color-success,var(--success,#157f37));--dshssh-scrim:#0f111557;--dshssh-shadow:0 24px 64px #0f111533;--dshssh-surface-2:color-mix(in srgb, var(--dshssh-fg) 3%, var(--dshssh-surface));--dshssh-surface-3:color-mix(in srgb, var(--dshssh-fg) 7%, var(--dshssh-surface));--dshssh-surface-inset:color-mix(in srgb, black 6%, var(--dshssh-surface));--dshssh-line:color-mix(in srgb, var(--dshssh-fg) 8%, var(--dshssh-surface));--dshssh-border:color-mix(in srgb, var(--dshssh-fg) 14%, var(--dshssh-surface));--dshssh-border-strong:color-mix(in srgb, var(--dshssh-fg) 26%, var(--dshssh-surface));--dshssh-fg-muted:color-mix(in srgb, var(--dshssh-fg) 60%, var(--dshssh-surface));--dshssh-fg-subtle:color-mix(in srgb, var(--dshssh-fg) 38%, var(--dshssh-surface));--dshssh-accent-soft:color-mix(in srgb, var(--dshssh-accent) 11%, var(--dshssh-surface));--dshssh-danger-soft:color-mix(in srgb, var(--dshssh-danger) 10%, var(--dshssh-surface));--dshssh-success-soft:color-mix(in srgb, var(--dshssh-success) 10%, var(--dshssh-surface));--dshssh-danger-text:color-mix(in srgb, var(--dshssh-danger) 55%, var(--dshssh-fg));--dshssh-success-text:color-mix(in srgb, var(--dshssh-success) 45%, var(--dshssh-fg))}}.yDo7AG_overlay{z-index:1000;background:var(--dshssh-scrim);font-family:var(--font-sans,ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"PingFang SC\", \"Microsoft YaHei\", sans-serif);justify-content:center;align-items:center;padding:24px;display:flex;position:fixed;inset:0}.yDo7AG_overlay button,.yDo7AG_overlay input{font-family:inherit}.yDo7AG_overlay :focus-visible{outline:2px solid var(--dshssh-accent);outline-offset:1px}.yDo7AG_gap{flex:auto}.yDo7AG_mono{font-family:var(--font-mono,ui-monospace, \"SF Mono\", \"Cascadia Code\", Consolas, monospace)}.yDo7AG_spin{animation:.8s linear infinite yDo7AG_dshssh-rotate}@keyframes yDo7AG_dshssh-rotate{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.yDo7AG_spin{animation:none}}.yDo7AG_button{border:1px solid var(--dshssh-border);color:var(--dshssh-fg);cursor:pointer;white-space:nowrap;background:0 0;border-radius:7px;justify-content:center;align-items:center;gap:6px;padding:5px 13px;font-size:12.5px;font-weight:500;line-height:1.4;display:inline-flex}.yDo7AG_button svg{flex:none}.yDo7AG_button:hover:not(:disabled){background:var(--dshssh-surface-3);border-color:var(--dshssh-border-strong)}.yDo7AG_primary{background:var(--dshssh-accent);border-color:var(--dshssh-accent);color:var(--dshssh-accent-fg)}.yDo7AG_primary:hover:not(:disabled){background:color-mix(in srgb, var(--dshssh-accent) 85%, #fff);border-color:color-mix(in srgb, var(--dshssh-accent) 85%, #fff)}.yDo7AG_danger{background:var(--dshssh-danger);border-color:var(--dshssh-danger);color:#fff}.yDo7AG_danger:hover:not(:disabled){background:color-mix(in srgb, var(--dshssh-danger) 82%, #fff);border-color:color-mix(in srgb, var(--dshssh-danger) 82%, #fff)}.yDo7AG_button:disabled{opacity:.5;cursor:default}.yDo7AG_iconButton{width:28px;height:28px;color:var(--dshssh-fg-muted);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;justify-content:center;align-items:center;display:inline-flex}.yDo7AG_iconButton:hover:not(:disabled){background:var(--dshssh-surface-3);color:var(--dshssh-fg)}.yDo7AG_iconButton:disabled{opacity:.45;cursor:default}.yDo7AG_dialog{background:var(--dshssh-surface);width:min(920px,100%);height:min(620px,100vh - 48px);color:var(--dshssh-fg);border:1px solid var(--dshssh-border);box-shadow:var(--dshssh-shadow);border-radius:12px;flex-direction:column;font-size:13px;display:flex;overflow:hidden}.yDo7AG_header{align-items:center;gap:10px;padding:14px 16px 10px;display:flex}.yDo7AG_headerText{flex:auto;min-width:0}.yDo7AG_title{margin:0;font-size:15px;font-weight:600;line-height:1.35}.yDo7AG_subtitle{color:var(--dshssh-fg-muted);text-overflow:ellipsis;white-space:nowrap;margin:2px 0 0;font-size:12px;overflow:hidden}.yDo7AG_body{flex:auto;min-height:0;display:flex}.yDo7AG_sidebar{border-right:1px solid var(--dshssh-line);background:var(--dshssh-surface-2);flex-direction:column;flex:none;width:268px;padding:10px;display:flex;overflow-y:auto}.yDo7AG_main{flex-direction:column;flex:auto;min-width:0;display:flex}.yDo7AG_sidebarSection{flex-direction:column;display:flex}.yDo7AG_sidebarSection+.yDo7AG_sidebarSection{border-top:1px solid var(--dshssh-line);margin-top:10px;padding-top:10px}.yDo7AG_sidebarAdd{background:var(--dshssh-accent);width:30px;height:30px;color:var(--dshssh-accent-fg);cursor:pointer;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;margin-top:10px;margin-left:auto;padding:0;display:inline-flex;position:sticky;bottom:4px;box-shadow:0 4px 12px #00000047}.yDo7AG_sidebarAdd:hover{filter:brightness(1.1)}.yDo7AG_sidebarTitle{color:var(--dshssh-fg-subtle);letter-spacing:.08em;text-transform:uppercase;align-items:center;gap:6px;margin:0 0 4px;padding:0 2px;font-size:10.5px;font-weight:600;display:flex}.yDo7AG_sidebarCount{background:var(--dshssh-surface-3);color:var(--dshssh-fg-muted);border-radius:8px;padding:0 6px;font-size:11px;font-weight:600;line-height:17px}.yDo7AG_sideError{background:var(--dshssh-danger-soft);border:1px solid color-mix(in srgb, var(--dshssh-danger) 28%, transparent);border-radius:8px;flex-direction:column;align-items:flex-start;gap:6px;padding:8px 10px;display:flex}.yDo7AG_sideErrorText{color:var(--dshssh-danger-text);overflow-wrap:anywhere;margin:0;font-size:12px}.yDo7AG_sideEmpty{flex-direction:column;align-items:flex-start;gap:3px;padding:6px 2px 4px;display:flex}.yDo7AG_sideEmptyIcon{color:var(--dshssh-fg-subtle);margin-bottom:2px}.yDo7AG_sideEmptyTitle{color:var(--dshssh-fg);margin:0;font-size:12.5px;font-weight:600}.yDo7AG_sideEmptyText{color:var(--dshssh-fg-muted);margin:0;font-size:12px;line-height:1.5}.yDo7AG_hostWorking{color:var(--dshssh-fg-muted);align-items:center;gap:5px;font-size:12px;display:inline-flex}.yDo7AG_hostSpinner{width:12px;height:12px;color:var(--dshssh-accent)}.yDo7AG_hostErrorText{color:var(--dshssh-danger-text);overflow-wrap:anywhere;font-size:12px;line-height:1.45}.yDo7AG_toolbar{border-top:1px solid var(--dshssh-line);border-bottom:1px solid var(--dshssh-line);background:var(--dshssh-surface-2);align-items:center;gap:8px;min-height:36px;padding:5px 16px;display:flex}.yDo7AG_crumbs{flex-wrap:wrap;flex:auto;align-items:center;gap:2px;min-width:0;font-size:12px;display:flex}.yDo7AG_crumb{color:var(--dshssh-accent);cursor:pointer;text-overflow:ellipsis;white-space:nowrap;background:0 0;border:none;border-radius:4px;max-width:22ch;padding:2px 5px;font-size:12px;overflow:hidden}.yDo7AG_crumb:hover:not(:disabled){background:var(--dshssh-surface-3)}.yDo7AG_crumb:disabled{color:var(--dshssh-fg-subtle);cursor:default}.yDo7AG_crumbStep{align-items:center;display:inline-flex}.yDo7AG_crumbSep{color:var(--dshssh-fg-subtle);padding:0 1px}.yDo7AG_crumbCurrent{color:var(--dshssh-fg);text-overflow:ellipsis;white-space:nowrap;max-width:44ch;padding:2px 5px;font-weight:600;overflow:hidden}.yDo7AG_toolbarActions{flex:none;align-items:center;gap:4px;display:flex}.yDo7AG_toolButton{width:28px;height:28px;color:var(--dshssh-fg-muted);cursor:pointer;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;display:inline-flex;position:relative}.yDo7AG_toolButtonText{border:1px solid var(--dshssh-border);width:auto;color:var(--dshssh-fg);gap:5px;padding:0 9px;font-size:12px;font-weight:500}.yDo7AG_toolButton:hover:not(:disabled):not(.yDo7AG_toolButtonOn){background:var(--dshssh-surface-3);color:var(--dshssh-fg)}.yDo7AG_toolButton:disabled{opacity:.45;cursor:default}.yDo7AG_toolButtonOn{background:var(--dshssh-accent-soft);color:var(--dshssh-accent)}.yDo7AG_countBadge{background:var(--dshssh-accent);min-width:14px;height:14px;color:var(--dshssh-accent-fg);text-align:center;border-radius:7px;padding:0 3px;font-size:10px;font-weight:600;line-height:14px;position:absolute;top:-3px;right:-5px}.yDo7AG_browser{flex:auto;min-height:200px;padding:6px 10px 8px 8px;overflow-y:auto}.yDo7AG_browserBusy .yDo7AG_entryList{opacity:.55;pointer-events:none}.yDo7AG_entryList{flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;display:flex}.yDo7AG_entry{width:100%;color:var(--dshssh-fg);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:7px;align-items:center;gap:8px;padding:6px 10px;font-size:13px;display:flex}.yDo7AG_entry:hover{background:var(--dshssh-surface-3)}.yDo7AG_entryIcon{color:var(--dshssh-fg-muted);flex:none}.yDo7AG_entryName{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.yDo7AG_entryHidden .yDo7AG_entryName,.yDo7AG_entryHidden .yDo7AG_entryIcon{opacity:.65}.yDo7AG_entryChevron{color:var(--dshssh-fg-subtle);opacity:0;flex:none;transition:opacity .12s}.yDo7AG_entry:hover .yDo7AG_entryChevron,.yDo7AG_entry:focus-visible .yDo7AG_entryChevron{opacity:1}.yDo7AG_truncated{color:var(--dshssh-fg-subtle);margin:6px 4px 0;font-size:12px}.yDo7AG_skeletons{flex-direction:column;gap:10px;padding:10px 6px;display:flex}.yDo7AG_skeleton{background:var(--dshssh-surface-3);border-radius:6px;height:12px;animation:1.4s ease-in-out infinite yDo7AG_dshssh-pulse}@keyframes yDo7AG_dshssh-pulse{0%,to{opacity:.45}50%{opacity:.9}}@media (prefers-reduced-motion:reduce){.yDo7AG_skeleton{opacity:.6;animation:none}}.yDo7AG_errorPanel{background:var(--dshssh-danger-soft);border:1px solid color-mix(in srgb, var(--dshssh-danger) 28%, transparent);border-radius:8px;align-items:flex-start;gap:10px;margin:10px 6px;padding:10px 12px;display:flex}.yDo7AG_errorIcon{color:var(--dshssh-danger-text);flex:none;margin-top:1px}.yDo7AG_errorBody{flex:auto;min-width:0}.yDo7AG_errorActions{flex-direction:column;flex:none;align-self:center;align-items:stretch;gap:6px;display:flex}.yDo7AG_errorTitle{color:var(--dshssh-danger-text);margin:0;font-size:12.5px;font-weight:600}.yDo7AG_errorText{color:var(--dshssh-fg-muted);overflow-wrap:anywhere;margin:2px 0 0;font-size:12px}.yDo7AG_retryButton{border:1px solid var(--dshssh-border);background:var(--dshssh-surface);color:var(--dshssh-fg);cursor:pointer;border-radius:6px;flex:none;align-items:center;gap:5px;padding:3px 9px;font-size:12px;display:inline-flex}.yDo7AG_retryButton:hover{background:var(--dshssh-surface-3)}.yDo7AG_emptyState{text-align:center;flex-direction:column;align-items:center;gap:4px;margin:auto;padding:28px 16px;display:flex}.yDo7AG_emptyIcon{color:var(--dshssh-fg-subtle);margin-bottom:4px}.yDo7AG_emptyTitle{color:var(--dshssh-fg);margin:0;font-size:13px;font-weight:600}.yDo7AG_emptyText{color:var(--dshssh-fg-muted);margin:0;font-size:12px}.yDo7AG_connectionList{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}.yDo7AG_connectionItem{border-radius:8px;align-items:stretch;gap:2px;display:flex}.yDo7AG_connectionItem:hover:not(.yDo7AG_connectionItemActive){background:color-mix(in srgb, var(--dshssh-fg) 4%, transparent)}.yDo7AG_connectionItemActive{background:var(--dshssh-accent-soft)}.yDo7AG_connectionMain{min-width:0;color:var(--dshssh-fg);font-size:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:7px;flex:auto;align-items:center;gap:10px;padding:5px 9px;display:flex}.yDo7AG_connectionIcon{color:var(--dshssh-fg-muted);flex:none}.yDo7AG_connectionItemActive .yDo7AG_connectionIcon{color:var(--dshssh-accent)}.yDo7AG_connectionInfo{flex-direction:column;flex:auto;gap:1px;min-width:0;display:flex}.yDo7AG_connectionLabel{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;overflow:hidden}.yDo7AG_connectionDetail{color:var(--dshssh-fg-muted);align-items:center;gap:5px;min-width:0;font-size:11.5px;display:flex}.yDo7AG_connectionEndpoint{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.yDo7AG_badge{background:color-mix(in srgb, var(--dshssh-fg) 5%, transparent);height:15px;color:var(--dshssh-fg-subtle);border:none;border-radius:4px;flex:none;align-items:center;gap:3px;padding:0 5px;font-size:10.5px;font-weight:500;line-height:14px;display:inline-flex}.yDo7AG_connectionItemActive .yDo7AG_badge{background:color-mix(in srgb, var(--dshssh-surface) 55%, transparent)}.yDo7AG_badge svg{width:11px;height:11px}.yDo7AG_badgeAdded{background:var(--dshssh-success-soft);color:var(--dshssh-success-text)}.yDo7AG_connectionRemove{width:30px;color:var(--dshssh-fg-subtle);cursor:pointer;opacity:0;background:0 0;border:none;border-radius:7px;flex:none;justify-content:center;align-items:center;transition:opacity .12s;display:inline-flex}.yDo7AG_connectionItem:hover .yDo7AG_connectionRemove,.yDo7AG_connectionRemove:focus-visible,.yDo7AG_connectionItemActive .yDo7AG_connectionRemove{opacity:1}.yDo7AG_connectionRemove:hover{color:var(--dshssh-danger-text);background:var(--dshssh-danger-soft)}@media (hover:none){.yDo7AG_connectionRemove{opacity:1}}.yDo7AG_skeletonRow{align-items:center;gap:10px;padding:10px 6px;display:flex}.yDo7AG_skeletonDot{background:var(--dshssh-surface-3);border-radius:5px;flex:none;width:16px;height:16px;animation:1.4s ease-in-out infinite yDo7AG_dshssh-pulse}.yDo7AG_skeletonLines{flex-direction:column;flex:auto;gap:6px;display:flex}.yDo7AG_skeletonLine{background:var(--dshssh-surface-3);border-radius:5px;height:9px;animation:1.4s ease-in-out infinite yDo7AG_dshssh-pulse}.yDo7AG_footer{border-top:1px solid var(--dshssh-line);align-items:center;gap:8px;padding:12px 16px 14px;display:flex}.yDo7AG_smallDialog,.yDo7AG_form{background:var(--dshssh-surface);width:min(520px,100%);max-height:calc(100vh - 48px);color:var(--dshssh-fg);border:1px solid var(--dshssh-border);box-shadow:var(--dshssh-shadow);border-radius:12px;flex-direction:column;gap:12px;padding:16px 18px;font-size:13px;display:flex;overflow-y:auto}.yDo7AG_form{width:min(560px,100%)}.yDo7AG_formTitle{margin:0;font-size:14px;font-weight:600}.yDo7AG_formSub{color:var(--dshssh-fg-muted);margin:2px 0 0;font-size:12px}.yDo7AG_formHead{align-items:flex-start;gap:10px;display:flex}.yDo7AG_formHeadText{flex:auto;min-width:0}.yDo7AG_formGrid{flex-direction:column;gap:12px;display:flex}.yDo7AG_formGrid>.yDo7AG_field{flex:none}.yDo7AG_rowFields{flex-wrap:wrap;gap:10px;display:flex}.yDo7AG_field{flex-direction:column;flex:180px;gap:5px;min-width:0;display:flex}.yDo7AG_fieldPort{flex:0 96px}.yDo7AG_fieldLabel{color:var(--dshssh-fg-muted);font-size:12px;font-weight:500}.yDo7AG_required{color:var(--dshssh-danger-text);margin-left:2px}.yDo7AG_fieldGroup{flex-direction:column;gap:5px;display:flex}.yDo7AG_input{box-sizing:border-box;background:var(--dshssh-surface-inset);border:1px solid var(--dshssh-border);width:100%;color:var(--dshssh-fg);border-radius:7px;outline:none;padding:7px 10px;font-size:13px}.yDo7AG_input::placeholder{color:var(--dshssh-fg-subtle)}.yDo7AG_input:focus{border-color:var(--dshssh-accent);box-shadow:0 0 0 3px var(--dshssh-accent-soft)}.yDo7AG_input:disabled{opacity:.6}.yDo7AG_inputError{border-color:var(--dshssh-danger)}.yDo7AG_inputError:focus{border-color:var(--dshssh-danger);box-shadow:0 0 0 3px var(--dshssh-danger-soft)}.yDo7AG_fieldError{color:var(--dshssh-danger-text);margin:0;font-size:11.5px}.yDo7AG_fieldHint{color:var(--dshssh-fg-subtle);font-size:11.5px}.yDo7AG_segment{border:1px solid var(--dshssh-line);background:var(--dshssh-surface-inset);border-radius:9px;gap:3px;width:fit-content;padding:3px;display:inline-flex}.yDo7AG_segmentButton{color:var(--dshssh-fg-muted);cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;gap:6px;padding:4px 14px;font-size:12.5px;font-weight:500;display:inline-flex}.yDo7AG_segmentButton:hover:not(.yDo7AG_segmentButtonOn):not(:disabled){color:var(--dshssh-fg)}.yDo7AG_segmentButtonOn{background:var(--dshssh-surface-3);color:var(--dshssh-fg);box-shadow:inset 0 0 0 1px var(--dshssh-border-strong)}.yDo7AG_segmentButtonOn svg{color:var(--dshssh-accent)}.yDo7AG_segmentButton:disabled{opacity:.55;cursor:default}.yDo7AG_feedback{overflow-wrap:anywhere;border-radius:7px;align-items:flex-start;gap:8px;padding:8px 11px;font-size:12.5px;line-height:1.45;display:flex}.yDo7AG_feedback svg{flex:none;margin-top:1px}.yDo7AG_feedbackInfo{background:var(--dshssh-surface-2);border:1px solid var(--dshssh-line);color:var(--dshssh-fg-muted)}.yDo7AG_feedbackSuccess{background:var(--dshssh-success-soft);border:1px solid color-mix(in srgb, var(--dshssh-success) 26%, transparent);color:var(--dshssh-success-text)}.yDo7AG_feedbackError{background:var(--dshssh-danger-soft);border:1px solid color-mix(in srgb, var(--dshssh-danger) 26%, transparent);color:var(--dshssh-danger-text)}.yDo7AG_formActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.yDo7AG_createIn{color:var(--dshssh-fg-muted);overflow-wrap:anywhere;margin:0;font-size:12px}.yDo7AG_createPath{color:var(--dshssh-fg);font-size:11.5px}.yDo7AG_confirmHead{align-items:flex-start;gap:12px;display:flex}.yDo7AG_confirmIconWrap{background:var(--dshssh-danger-soft);width:34px;height:34px;color:var(--dshssh-danger-text);border-radius:9px;flex:none;justify-content:center;align-items:center;display:inline-flex}.yDo7AG_confirmIconInfo{background:var(--dshssh-accent-soft);color:var(--dshssh-accent)}.yDo7AG_confirmText{color:var(--dshssh-fg-muted);overflow-wrap:anywhere;margin:3px 0 0;font-size:12.5px;line-height:1.55}@media (width<=640px){.yDo7AG_overlay{padding:12px}.yDo7AG_dialog,.yDo7AG_smallDialog,.yDo7AG_form{max-height:calc(100vh - 24px)}.yDo7AG_body{flex-direction:column}.yDo7AG_sidebar{border-right:none;border-bottom:1px solid var(--dshssh-line);width:auto;max-height:38%}.yDo7AG_main{min-height:0}.yDo7AG_errorPanel{flex-wrap:wrap}.yDo7AG_errorActions{flex-direction:row;align-self:flex-start}.yDo7AG_toolbar,.yDo7AG_footer{flex-wrap:wrap}}";
		const tagId = "dsh-remote-ssh/flow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-remote-ssh";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var flow_module_css_default = {
			"badge": "yDo7AG_badge",
			"badgeAdded": "yDo7AG_badgeAdded",
			"body": "yDo7AG_body",
			"browser": "yDo7AG_browser",
			"browserBusy": "yDo7AG_browserBusy",
			"button": "yDo7AG_button",
			"confirmHead": "yDo7AG_confirmHead",
			"confirmIconInfo": "yDo7AG_confirmIconInfo",
			"confirmIconWrap": "yDo7AG_confirmIconWrap",
			"confirmText": "yDo7AG_confirmText",
			"connectionDetail": "yDo7AG_connectionDetail",
			"connectionEndpoint": "yDo7AG_connectionEndpoint",
			"connectionIcon": "yDo7AG_connectionIcon",
			"connectionInfo": "yDo7AG_connectionInfo",
			"connectionItem": "yDo7AG_connectionItem",
			"connectionItemActive": "yDo7AG_connectionItemActive",
			"connectionLabel": "yDo7AG_connectionLabel",
			"connectionList": "yDo7AG_connectionList",
			"connectionMain": "yDo7AG_connectionMain",
			"connectionRemove": "yDo7AG_connectionRemove",
			"countBadge": "yDo7AG_countBadge",
			"createIn": "yDo7AG_createIn",
			"createPath": "yDo7AG_createPath",
			"crumb": "yDo7AG_crumb",
			"crumbCurrent": "yDo7AG_crumbCurrent",
			"crumbSep": "yDo7AG_crumbSep",
			"crumbStep": "yDo7AG_crumbStep",
			"crumbs": "yDo7AG_crumbs",
			"danger": "yDo7AG_danger",
			"dialog": "yDo7AG_dialog",
			"dshssh-pulse": "yDo7AG_dshssh-pulse",
			"dshssh-rotate": "yDo7AG_dshssh-rotate",
			"emptyIcon": "yDo7AG_emptyIcon",
			"emptyState": "yDo7AG_emptyState",
			"emptyText": "yDo7AG_emptyText",
			"emptyTitle": "yDo7AG_emptyTitle",
			"entry": "yDo7AG_entry",
			"entryChevron": "yDo7AG_entryChevron",
			"entryHidden": "yDo7AG_entryHidden",
			"entryIcon": "yDo7AG_entryIcon",
			"entryList": "yDo7AG_entryList",
			"entryName": "yDo7AG_entryName",
			"errorActions": "yDo7AG_errorActions",
			"errorBody": "yDo7AG_errorBody",
			"errorIcon": "yDo7AG_errorIcon",
			"errorPanel": "yDo7AG_errorPanel",
			"errorText": "yDo7AG_errorText",
			"errorTitle": "yDo7AG_errorTitle",
			"feedback": "yDo7AG_feedback",
			"feedbackError": "yDo7AG_feedbackError",
			"feedbackInfo": "yDo7AG_feedbackInfo",
			"feedbackSuccess": "yDo7AG_feedbackSuccess",
			"field": "yDo7AG_field",
			"fieldError": "yDo7AG_fieldError",
			"fieldGroup": "yDo7AG_fieldGroup",
			"fieldHint": "yDo7AG_fieldHint",
			"fieldLabel": "yDo7AG_fieldLabel",
			"fieldPort": "yDo7AG_fieldPort",
			"footer": "yDo7AG_footer",
			"form": "yDo7AG_form",
			"formActions": "yDo7AG_formActions",
			"formGrid": "yDo7AG_formGrid",
			"formHead": "yDo7AG_formHead",
			"formHeadText": "yDo7AG_formHeadText",
			"formSub": "yDo7AG_formSub",
			"formTitle": "yDo7AG_formTitle",
			"gap": "yDo7AG_gap",
			"header": "yDo7AG_header",
			"headerText": "yDo7AG_headerText",
			"hostErrorText": "yDo7AG_hostErrorText",
			"hostSpinner": "yDo7AG_hostSpinner",
			"hostWorking": "yDo7AG_hostWorking",
			"iconButton": "yDo7AG_iconButton",
			"input": "yDo7AG_input",
			"inputError": "yDo7AG_inputError",
			"main": "yDo7AG_main",
			"mono": "yDo7AG_mono",
			"overlay": "yDo7AG_overlay",
			"primary": "yDo7AG_primary",
			"required": "yDo7AG_required",
			"retryButton": "yDo7AG_retryButton",
			"rowFields": "yDo7AG_rowFields",
			"segment": "yDo7AG_segment",
			"segmentButton": "yDo7AG_segmentButton",
			"segmentButtonOn": "yDo7AG_segmentButtonOn",
			"sideEmpty": "yDo7AG_sideEmpty",
			"sideEmptyIcon": "yDo7AG_sideEmptyIcon",
			"sideEmptyText": "yDo7AG_sideEmptyText",
			"sideEmptyTitle": "yDo7AG_sideEmptyTitle",
			"sideError": "yDo7AG_sideError",
			"sideErrorText": "yDo7AG_sideErrorText",
			"sidebar": "yDo7AG_sidebar",
			"sidebarAdd": "yDo7AG_sidebarAdd",
			"sidebarCount": "yDo7AG_sidebarCount",
			"sidebarSection": "yDo7AG_sidebarSection",
			"sidebarTitle": "yDo7AG_sidebarTitle",
			"skeleton": "yDo7AG_skeleton",
			"skeletonDot": "yDo7AG_skeletonDot",
			"skeletonLine": "yDo7AG_skeletonLine",
			"skeletonLines": "yDo7AG_skeletonLines",
			"skeletonRow": "yDo7AG_skeletonRow",
			"skeletons": "yDo7AG_skeletons",
			"smallDialog": "yDo7AG_smallDialog",
			"spin": "yDo7AG_spin",
			"subtitle": "yDo7AG_subtitle",
			"title": "yDo7AG_title",
			"toolButton": "yDo7AG_toolButton",
			"toolButtonOn": "yDo7AG_toolButtonOn",
			"toolButtonText": "yDo7AG_toolButtonText",
			"toolbar": "yDo7AG_toolbar",
			"toolbarActions": "yDo7AG_toolbarActions",
			"truncated": "yDo7AG_truncated"
		};
		//#endregion
		//#region src/client/form.tsx
		/**
		* The 「新建连接」form: one SSH connection with password or private-key
		* authentication (二选一), an optional ProxyJump chain, and `~/.ssh/config`
		* alias recognition through the Host channel. The host field is alias-first:
		* blur or paste auto-resolves and prefills (the manual 「识别 ssh 配置」 button
		* stays as the loud fallback), and a successful resolve shows a one-line
		* summary (alias → user@host:port, identity file, jump chain). A `draft`
		* prefills the form — the sidebar opens it this way when a config host needs
		* its username or auth completed.
		*/
		/** Parse a `[user@]host[:port]` jump list (comma/space separated). */
		function parseJumpText(text) {
			return text.split(/[\s,]+/).map((entry) => entry.trim()).filter((entry) => entry !== "").map((entry) => {
				let rest = entry;
				let username;
				let port;
				const at = rest.lastIndexOf("@");
				if (at >= 0) {
					username = rest.slice(0, at);
					rest = rest.slice(at + 1);
				}
				const colon = rest.lastIndexOf(":");
				if (colon >= 0) {
					const parsed = Number(rest.slice(colon + 1));
					if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
						port = parsed;
						rest = rest.slice(0, colon);
					}
				}
				return {
					host: rest,
					...port !== void 0 ? { port } : {},
					...username !== void 0 && username !== "" ? { username } : {}
				};
			});
		}
		/** Render one resolved hop as `user@host:port` (defaults hidden). */
		function formatHop(hop) {
			return `${hop.username !== void 0 && hop.username !== "" ? `${hop.username}@` : ""}${hop.host}${hop.port !== void 0 && hop.port !== 22 ? `:${String(hop.port)}` : ""}`;
		}
		/** The one-line resolve summary: alias → user@host:port · identity · jumps. */
		function formatSummary(resolved) {
			const endpoint = `${resolved.username !== "" ? `${resolved.username}@` : ""}${resolved.host}${resolved.port !== 22 ? `:${String(resolved.port)}` : ""}`;
			const parts = [];
			if (resolved.alias.toLowerCase() !== resolved.host.toLowerCase()) parts.push(`${resolved.alias} → ${endpoint}`);
			else parts.push(endpoint);
			if (resolved.privateKeyPaths[0] !== void 0) parts.push(`私钥 ${resolved.privateKeyPaths[0]}`);
			if (resolved.jump.length > 0) parts.push(`跳板 ${resolved.jump.map(formatHop).join(" → ")}`);
			return parts.join(" · ");
		}
		/** The connection form modal (masked password, 密码/私钥二选一). */
		function ConnectionForm({ resolve, test, save, draft, onClose, onSaved }) {
			const [label, setLabel] = (0, react.useState)(draft?.label ?? "");
			const [host, setHost] = (0, react.useState)(draft?.host ?? "");
			const [port, setPort] = (0, react.useState)(draft?.port ?? "22");
			const [username, setUsername] = (0, react.useState)(draft?.username ?? "");
			const [authKind, setAuthKind] = (0, react.useState)("key");
			const [password, setPassword] = (0, react.useState)("");
			const [privateKeyPath, setPrivateKeyPath] = (0, react.useState)(draft?.privateKeyPath ?? "");
			const [passphrase, setPassphrase] = (0, react.useState)("");
			const [jumpText, setJumpText] = (0, react.useState)(draft?.jumpText ?? "");
			const [cwd, setCwd] = (0, react.useState)(draft?.cwd ?? "");
			const [busy, setBusy] = (0, react.useState)(false);
			const [busyTask, setBusyTask] = (0, react.useState)(null);
			const [feedback, setFeedback] = (0, react.useState)(null);
			const [revealed, setRevealed] = (0, react.useState)(false);
			const [resolveSummary, setResolveSummary] = (0, react.useState)(null);
			const [autoBusy, setAutoBusy] = (0, react.useState)(false);
			const dialogRef = useDialogA11y(true, () => {
				if (!busy) onClose();
			});
			const usernameRef = (0, react.useRef)(null);
			const autoGeneration = (0, react.useRef)(0);
			const lastAutoHost = (0, react.useRef)(null);
			const busyRef = (0, react.useRef)(false);
			busyRef.current = busy;
			/** A prefilled form that is missing its username focuses that field first. */
			(0, react.useEffect)(() => {
				if (draft?.focusUsername === true) usernameRef.current?.focus();
			}, [draft?.focusUsername]);
			const errors = () => {
				const result = {};
				if (host.trim() === "") result.host = "请填写主机名或 ~/.ssh/config 别名";
				const portText = port.trim();
				if (portText === "") result.port = "必填";
				else if (!/^\d+$/.test(portText)) result.port = "端口必须是数字";
				else {
					const value = Number(portText);
					if (value < 1 || value > 65535) result.port = "端口范围 1–65535";
				}
				if (username.trim() === "") result.username = "请填写登录用户名";
				return result;
			};
			const errorOf = (key) => revealed ? errors()[key] : void 0;
			const assemble = () => {
				const jump = parseJumpText(jumpText);
				const input = {
					host: host.trim(),
					...port.trim() !== "" && Number.isInteger(Number(port.trim())) ? { port: Number(port.trim()) } : {},
					...username.trim() !== "" ? { username: username.trim() } : {},
					...label.trim() !== "" ? { label: label.trim() } : {},
					...cwd.trim() !== "" ? { cwd: cwd.trim() } : {},
					...jump.length > 0 ? { jump } : {}
				};
				if (authKind === "password" && password !== "") input.password = password;
				if (authKind === "key" && privateKeyPath.trim() !== "") input.privateKeyPath = privateKeyPath.trim();
				if (authKind === "key" && passphrase !== "") input.passphrase = passphrase;
				return input;
			};
			/** Prefill every field the resolution covers; keep operator edits elsewhere. */
			const applyResolved = (resolved) => {
				setHost(resolved.host);
				if (resolved.port !== 22) setPort(String(resolved.port));
				if (resolved.username !== "") setUsername(resolved.username);
				if (resolved.privateKeyPaths.length > 0) {
					setAuthKind("key");
					setPrivateKeyPath(resolved.privateKeyPaths[0]);
				}
				setJumpText(resolved.jump.map(formatHop).join(", "));
				const user = resolved.username !== "" ? resolved.username : username;
				if (cwd.trim() === "" && user.trim() !== "") setCwd(`/home/${user.trim()}`);
				setResolveSummary(resolved);
			};
			/**
			* Silent alias resolution for blur/paste: no validation reveal, no error
			* surface, never disables the form. Guarded by its own generation counter
			* so a stale answer cannot clobber a newer edit.
			*/
			const autoResolve = async (value) => {
				const hostText = value.trim();
				if (hostText === "" || busyRef.current) return;
				if (lastAutoHost.current === hostText) return;
				lastAutoHost.current = hostText;
				const current = autoGeneration.current += 1;
				setAutoBusy(true);
				try {
					const resolved = await resolve(hostText);
					if (current !== autoGeneration.current) return;
					applyResolved(resolved);
				} catch {} finally {
					if (current === autoGeneration.current) setAutoBusy(false);
				}
			};
			const resolveConfig = async () => {
				setRevealed(true);
				if (host.trim() === "") {
					setFeedback({
						kind: "error",
						text: "请先填写主机名或 ~/.ssh/config 别名"
					});
					return;
				}
				autoGeneration.current += 1;
				setAutoBusy(false);
				setBusy(true);
				setBusyTask("resolve");
				setFeedback({
					kind: "info",
					text: "正在读取 ~/.ssh/config…"
				});
				try {
					const resolved = await resolve(host.trim());
					lastAutoHost.current = resolved.host;
					applyResolved(resolved);
					setFeedback({
						kind: "success",
						text: `已识别 ${resolved.alias} → ${resolved.username !== "" ? `${resolved.username}@` : ""}${resolved.host}${resolved.port !== 22 ? `:${String(resolved.port)}` : ""}`
					});
				} catch (error) {
					setFeedback({
						kind: "error",
						text: `识别失败：${error instanceof Error ? error.message : String(error)}`
					});
				} finally {
					setBusy(false);
					setBusyTask(null);
				}
			};
			const runTest = async () => {
				setRevealed(true);
				const input = assemble();
				if (host.trim() === "") {
					setFeedback({
						kind: "error",
						text: "请先填写主机名"
					});
					return;
				}
				if (authKind === "password" && input.password === void 0) {
					setFeedback({
						kind: "error",
						text: "请填写密码，或改用私钥认证"
					});
					return;
				}
				if (authKind === "key" && input.privateKeyPath === void 0) {
					setFeedback({
						kind: "error",
						text: "请填写私钥文件路径，或改用密码认证"
					});
					return;
				}
				setBusy(true);
				setBusyTask("test");
				setFeedback({
					kind: "info",
					text: "正在测试连接…"
				});
				try {
					const outcome = await test(input);
					setFeedback(outcome.ok ? {
						kind: "success",
						text: "连接成功，可以保存了"
					} : {
						kind: "error",
						text: `连接失败：${outcome.message ?? "未知错误"}`
					});
				} catch (error) {
					setFeedback({
						kind: "error",
						text: `测试失败：${error instanceof Error ? error.message : String(error)}`
					});
				} finally {
					setBusy(false);
					setBusyTask(null);
				}
			};
			const runSave = async () => {
				setRevealed(true);
				const found = errors();
				if (found.host !== void 0 || found.port !== void 0 || found.username !== void 0) {
					setFeedback({
						kind: "error",
						text: "请先补全上方必填项"
					});
					return;
				}
				const input = assemble();
				setBusy(true);
				setBusyTask("save");
				setFeedback({
					kind: "info",
					text: "正在保存…"
				});
				try {
					const outcome = await save(input);
					if (!outcome.ok || outcome.view === void 0) {
						setFeedback({
							kind: "error",
							text: `保存失败：${outcome.message ?? "未知错误"}`
						});
						return;
					}
					onSaved(outcome.view);
				} catch (error) {
					setFeedback({
						kind: "error",
						text: `保存失败：${error instanceof Error ? error.message : String(error)}`
					});
				} finally {
					setBusy(false);
					setBusyTask(null);
				}
			};
			const hostError = errorOf("host");
			const portError = errorOf("port");
			const usernameError = errorOf("username");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: flow_module_css_default.overlay,
				onClick: (event) => {
					if (event.target === event.currentTarget && !busy) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: flow_module_css_default.form,
					role: "dialog",
					"aria-modal": "true",
					"aria-label": "新建远程连接",
					ref: dialogRef,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: flow_module_css_default.formHead,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: flow_module_css_default.formHeadText,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: flow_module_css_default.formTitle,
									children: "新建远程连接"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: flow_module_css_default.formSub,
									children: "保存后将出现在连接侧栏中，可直接浏览其远程目录"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: flow_module_css_default.iconButton,
								"aria-label": "关闭",
								disabled: busy,
								onClick: onClose,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CloseIcon, {})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: flow_module_css_default.formGrid,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: flow_module_css_default.field,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: flow_module_css_default.fieldLabel,
											children: ["主机名 / 别名", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: flow_module_css_default.required,
												"aria-hidden": true,
												children: "*"
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: cx(flow_module_css_default.input, hostError !== void 0 && flow_module_css_default.inputError),
											value: host,
											placeholder: "prod 或 server.example.com",
											disabled: busy,
											onChange: (event) => {
												setHost(event.target.value);
												setResolveSummary(null);
												lastAutoHost.current = null;
											},
											onBlur: () => {
												autoResolve(host);
											},
											onPaste: (event) => {
												const text = event.clipboardData.getData("text");
												if (text.trim() !== "") autoResolve(text);
											}
										}),
										autoBusy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldHint,
											role: "status",
											children: "正在匹配 ~/.ssh/config…"
										}),
										hostError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldError,
											children: hostError
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldHint,
											children: "填写 ~/.ssh/config 里的别名可在失焦时自动补全用户名、端口、私钥与跳板"
										})
									]
								}),
								resolveSummary !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: cx(flow_module_css_default.feedback, flow_module_css_default.feedbackSuccess),
									role: "status",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckIcon, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: flow_module_css_default.mono,
										children: formatSummary(resolveSummary)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: flow_module_css_default.rowFields,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: cx(flow_module_css_default.field, flow_module_css_default.fieldPort),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: flow_module_css_default.fieldLabel,
												children: ["端口", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: flow_module_css_default.required,
													"aria-hidden": true,
													children: "*"
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: cx(flow_module_css_default.input, portError !== void 0 && flow_module_css_default.inputError),
												value: port,
												inputMode: "numeric",
												disabled: busy,
												onChange: (event) => {
													setPort(event.target.value);
												}
											}),
											portError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: flow_module_css_default.fieldError,
												children: portError
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: flow_module_css_default.field,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: flow_module_css_default.fieldLabel,
												children: ["用户名", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: flow_module_css_default.required,
													"aria-hidden": true,
													children: "*"
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												ref: usernameRef,
												className: cx(flow_module_css_default.input, usernameError !== void 0 && flow_module_css_default.inputError),
												value: username,
												disabled: busy,
												onChange: (event) => {
													setUsername(event.target.value);
												}
											}),
											usernameError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: flow_module_css_default.fieldError,
												children: usernameError
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: flow_module_css_default.rowFields,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: flow_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldLabel,
											children: "名称（可选）"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: flow_module_css_default.input,
											value: label,
											placeholder: "默认 user@host",
											disabled: busy,
											onChange: (event) => {
												setLabel(event.target.value);
											}
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: flow_module_css_default.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldLabel,
											children: "工作目录（可选）"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: flow_module_css_default.input,
											value: cwd,
											placeholder: "/home/username",
											disabled: busy,
											onChange: (event) => {
												setCwd(event.target.value);
											}
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: flow_module_css_default.fieldGroup,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: flow_module_css_default.fieldLabel,
										id: "dsh-ssh-auth-label",
										children: "认证方式"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: flow_module_css_default.segment,
										role: "radiogroup",
										"aria-labelledby": "dsh-ssh-auth-label",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											role: "radio",
											"aria-checked": authKind === "key",
											className: cx(flow_module_css_default.segmentButton, authKind === "key" && flow_module_css_default.segmentButtonOn),
											disabled: busy,
											onClick: () => {
												setAuthKind("key");
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyIcon, {}), "私钥文件"]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											role: "radio",
											"aria-checked": authKind === "password",
											className: cx(flow_module_css_default.segmentButton, authKind === "password" && flow_module_css_default.segmentButtonOn),
											disabled: busy,
											onClick: () => {
												setAuthKind("password");
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LockIcon, {}), "密码"]
										})]
									})]
								}),
								authKind === "key" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: flow_module_css_default.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: flow_module_css_default.fieldLabel,
										children: "私钥文件路径"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: flow_module_css_default.input,
										value: privateKeyPath,
										placeholder: "~/.ssh/id_ed25519",
										disabled: busy,
										onChange: (event) => {
											setPrivateKeyPath(event.target.value);
										}
									})]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: flow_module_css_default.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: flow_module_css_default.fieldLabel,
										children: "密码"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "password",
										className: flow_module_css_default.input,
										value: password,
										disabled: busy,
										onChange: (event) => {
											setPassword(event.target.value);
										}
									})]
								}),
								authKind === "key" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: flow_module_css_default.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: flow_module_css_default.fieldLabel,
										children: "私钥口令（可选）"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "password",
										className: flow_module_css_default.input,
										value: passphrase,
										disabled: busy,
										onChange: (event) => {
											setPassphrase(event.target.value);
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: flow_module_css_default.field,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldLabel,
											children: "跳板链（可选）"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: flow_module_css_default.input,
											value: jumpText,
											placeholder: "bastion 或 user@bastion.example.com:2202，多台用逗号分隔",
											disabled: busy,
											onChange: (event) => {
												setJumpText(event.target.value);
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: flow_module_css_default.fieldHint,
											children: "支持 ~/.ssh/config 别名；格式 user@host:port，按连接顺序排列"
										})
									]
								})
							]
						}),
						feedback !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: cx(flow_module_css_default.feedback, feedback.kind === "success" ? flow_module_css_default.feedbackSuccess : feedback.kind === "error" ? flow_module_css_default.feedbackError : flow_module_css_default.feedbackInfo),
							role: feedback.kind === "error" ? "alert" : "status",
							children: [busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }) : feedback.kind === "success" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckIcon, {}) : feedback.kind === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AlertIcon, {}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: feedback.text })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: flow_module_css_default.formActions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: flow_module_css_default.button,
									disabled: busy,
									onClick: () => {
										resolveConfig();
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SparkIcon, {}), "识别 ssh 配置"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: flow_module_css_default.button,
									disabled: busy,
									onClick: () => {
										runTest();
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RouteIcon, {}), "测试连接"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: flow_module_css_default.gap }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: flow_module_css_default.button,
									disabled: busy,
									onClick: onClose,
									children: "取消"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: cx(flow_module_css_default.button, flow_module_css_default.primary),
									disabled: busy,
									onClick: () => {
										runSave();
									},
									children: [busyTask === "save" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }), "保存连接"]
								})
							]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/flow.tsx
		/**
		* The add-workspace directory flow of dsh-ssh, laid out as a connection
		* sidebar beside a directory browser (VS Code Remote Explorer style): the
		* sidebar lists `~/.ssh/config` hosts (one click resolves, registers, and
		* browses — no form), saved connections, and the local entry; the right pane
		* browses whichever side is active. Picking a remote directory hands the owner
		* an `ssh://<id><path>` workspace path, which the deployment's remote
		* providers consume (see README for the workspace-adoption seam).
		*/
		const EMPTY_PANE = {
			path: null,
			listing: null,
			error: null,
			loading: false
		};
		/** Unwrap a wire result or throw its business error. */
		function unwrap(result, fallback) {
			if (!result.ok) throw new Error(result.error.message || fallback);
			return result.value;
		}
		const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
		/** Minimal structural check for a wire listing. */
		function asListing(value) {
			const record = isRecord(value) ? value : {};
			const wireEntry = (entry) => ({
				name: String(entry?.name ?? ""),
				path: String(entry?.path ?? ""),
				hidden: entry?.hidden === true
			});
			return {
				path: typeof record.path === "string" ? record.path : "",
				home: typeof record.home === "string" ? record.home : "",
				crumbs: Array.isArray(record.crumbs) ? record.crumbs.filter(isRecord).map(wireEntry) : [],
				entries: Array.isArray(record.entries) ? record.entries.filter(isRecord).map(wireEntry) : [],
				truncated: record.truncated === true
			};
		}
		/** Structural check for one `config.hosts` row. */
		function asConfigHosts(value) {
			if (!Array.isArray(value)) return [];
			return value.filter(isRecord).map((record) => ({
				alias: String(record.alias ?? ""),
				host: String(record.host ?? ""),
				username: String(record.username ?? ""),
				port: typeof record.port === "number" ? record.port : 22,
				identityFile: record.identityFile === true,
				jump: record.jump === true
			})).filter((host) => host.alias !== "");
		}
		/** Structural check for one secret-free connection view. */
		function asConnectionView(record) {
			return {
				id: String(record.id ?? ""),
				label: String(record.label ?? ""),
				host: String(record.host ?? ""),
				port: typeof record.port === "number" ? record.port : 22,
				username: String(record.username ?? ""),
				...typeof record.cwd === "string" ? { cwd: record.cwd } : {},
				auth: record.auth === "password" || record.auth === "agent" ? record.auth : "key",
				jumpHosts: Array.isArray(record.jumpHosts) ? record.jumpHosts.map(String) : []
			};
		}
		/** Structural check for a `connections.resolve` result. */
		function asResolved(value) {
			const record = isRecord(value) ? value : {};
			return {
				host: typeof record.host === "string" ? record.host : "",
				username: typeof record.username === "string" ? record.username : "",
				port: typeof record.port === "number" ? record.port : 22,
				privateKeyPaths: Array.isArray(record.privateKeyPaths) ? record.privateKeyPaths.map(String) : [],
				jump: Array.isArray(record.jump) ? record.jump.filter(isRecord).map((hop) => ({
					host: String(hop.host ?? ""),
					...typeof hop.port === "number" ? { port: hop.port } : {},
					...typeof hop.username === "string" && hop.username !== "" ? { username: hop.username } : {},
					...hop.privateKeyPath !== void 0 ? { privateKeyPath: String(hop.privateKeyPath) } : {}
				})) : [],
				alias: typeof record.alias === "string" ? record.alias : ""
			};
		}
		/** Structural check for a `connections.add` result (its view only). */
		function asAddedView(value) {
			const record = isRecord(value) ? value : {};
			return asConnectionView(isRecord(record.view) ? record.view : {});
		}
		/**
		* Translate a raw ssh2/web error into a readable remote failure. ssh2 never
		* consults the OS agent or default identities on its own, so a spec without
		* password/privateKey/agent surfaces as `All configured authentication
		* methods failed` — that one gets the auth-completion guidance.
		*/
		function describeRemoteFailure(raw) {
			if (/invalid_union/.test(raw)) return {
				title: "无法创建远程会话",
				text: "宿主返回了无法解析的错误响应——最常见的原因是 SSH 连接失败。请检查该主机的认证与网络配置后重试。",
				needsAuth: false
			};
			if (/all configured authentication methods/i.test(raw)) return {
				title: "认证失败",
				text: "该主机没有可用的私钥或密码，SSH 服务器拒绝了登录。可点击「补全认证」，在表单中填写认证信息后重试。",
				needsAuth: true
			};
			if (/cannot parse privatekey|cannot read private key|invalid private key|no key found/i.test(raw)) return {
				title: "私钥不可用",
				text: `无法读取或解析私钥文件，请检查路径、口令与文件权限。原始错误：${raw}`,
				needsAuth: true
			};
			if (/timed?\s?out|etimedout/i.test(raw)) return {
				title: "连接超时",
				text: "在超时前未能建立连接，请检查主机名、端口与网络可达性。",
				needsAuth: false
			};
			if (/econnrefused/i.test(raw)) return {
				title: "连接被拒绝",
				text: "目标端口未开放或拒绝了连接，请核对端口。",
				needsAuth: false
			};
			if (/enotfound|getaddrinfo|dns/i.test(raw)) return {
				title: "找不到主机",
				text: "域名解析失败，请核对主机名或修正 ~/.ssh/config 中的 HostName。",
				needsAuth: false
			};
			if (/ehostunreach|enetunreach/i.test(raw)) return {
				title: "网络不可达",
				text: "本机无法路由到该主机，请检查网络或跳板配置。",
				needsAuth: false
			};
			return {
				title: "无法连接远程主机",
				text: raw,
				needsAuth: false
			};
		}
		/** The directory-flow occupant registered into both workspace holes. */
		function SshWorkspaceFlow(props) {
			const { open, busy, onPicked, onCancel, listLocalDirectory, createLocalDirectory, rpc } = props;
			const [mode, setMode] = (0, react.useState)({ kind: "local" });
			const [pane, setPane] = (0, react.useState)(EMPTY_PANE);
			const [connections, setConnections] = (0, react.useState)([]);
			const [connectionsLoading, setConnectionsLoading] = (0, react.useState)(false);
			const [connectionsError, setConnectionsError] = (0, react.useState)(null);
			const [configHosts, setConfigHosts] = (0, react.useState)([]);
			const [configLoading, setConfigLoading] = (0, react.useState)(false);
			const [configError, setConfigError] = (0, react.useState)(null);
			const [hostPending, setHostPending] = (0, react.useState)(null);
			const [hostError, setHostError] = (0, react.useState)(null);
			const [confirmTarget, setConfirmTarget] = (0, react.useState)(null);
			const [formOpen, setFormOpen] = (0, react.useState)(false);
			const [formDraft, setFormDraft] = (0, react.useState)(void 0);
			const [folderDraft, setFolderDraft] = (0, react.useState)(null);
			const [openingRemote, setOpeningRemote] = (0, react.useState)(false);
			const [folderBusy, setFolderBusy] = (0, react.useState)(false);
			const [folderError, setFolderError] = (0, react.useState)(null);
			const [showHidden, setShowHidden] = (0, react.useState)(false);
			const [nativePicking, setNativePicking] = (0, react.useState)(false);
			const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
			const [removingId, setRemovingId] = (0, react.useState)(null);
			const generation = (0, react.useRef)(0);
			const activeRequest = (0, react.useRef)(null);
			const configGeneration = (0, react.useRef)(0);
			const configRequest = (0, react.useRef)(null);
			const modeRef = (0, react.useRef)(mode);
			modeRef.current = mode;
			const paneRef = (0, react.useRef)(pane);
			paneRef.current = pane;
			const dialogRef = useDialogA11y(open, () => {
				onCancel();
			});
			const folderDialogRef = useDialogA11y(folderDraft !== null, () => {
				if (!folderBusy) setFolderDraft(null);
			});
			const deleteDialogRef = useDialogA11y(deleteTarget !== null, () => {
				if (removingId === null) setDeleteTarget(null);
			});
			const confirmDialogRef = useDialogA11y(confirmTarget !== null, () => {
				if (hostPending === null) setConfirmTarget(null);
			});
			/** List one level, guarding against superseded/closed generations. */
			const loadLevel = async (request) => {
				const current = generation.current += 1;
				const controller = new AbortController();
				activeRequest.current = controller;
				setPane((previous) => ({
					...previous,
					loading: true,
					error: null
				}));
				try {
					const listing = await request(controller.signal);
					if (current !== generation.current || controller.signal.aborted) return;
					setPane({
						path: listing.path,
						listing,
						error: null,
						loading: false
					});
				} catch (error) {
					if (current !== generation.current || controller.signal.aborted) return;
					setPane((previous) => ({
						...previous,
						loading: false,
						error: error instanceof Error ? error.message : String(error)
					}));
				}
			};
			const navigateLocal = (path) => {
				setMode({ kind: "local" });
				loadLevel((signal) => listLocalDirectory(path, signal));
			};
			const navigateRemote = (id, path) => {
				setMode({
					kind: "remote",
					id
				});
				loadLevel(async (signal) => asListing(unwrap(await rpc("browse.list", {
					id,
					...path !== void 0 ? { path } : {}
				}, signal), "browse.list failed")));
			};
			const openRemotePath = async () => {
				if (mode.kind !== "remote" || pane.path === null || openingRemote) return;
				setOpeningRemote(true);
				try {
					const routed = unwrap(await rpc("session.route", {
						id: mode.id,
						path: pane.path
					}), "session.route failed");
					const cwd = isRecord(routed) && typeof routed.cwd === "string" ? routed.cwd : "";
					if (cwd === "") throw new Error("session.route 未返回会话目录");
					onPicked(cwd);
				} catch (error) {
					setPane((previous) => ({
						...previous,
						error: error instanceof Error ? error.message : String(error)
					}));
				} finally {
					setOpeningRemote(false);
				}
			};
			/**
			* Refresh the connection list. `silent` keeps the previous list on screen
			* (post-mutation refreshes) instead of flashing the skeleton.
			*/
			const refreshConnections = async (silent = false) => {
				if (!silent) setConnectionsLoading(true);
				try {
					const value = unwrap(await rpc("connections.list"), "connections.list failed");
					if (Array.isArray(value)) {
						setConnections(value.filter(isRecord).map(asConnectionView));
						setConnectionsError(null);
					}
				} catch (error) {
					setConnectionsError(error instanceof Error ? error.message : String(error));
				} finally {
					if (!silent) setConnectionsLoading(false);
				}
			};
			/**
			* Refresh the `~/.ssh/config` host list (the Host re-reads the file on every
			* call). Same generation + abort guard as the directory pane so closing the
			* dialog or a rapid retry can never apply a stale answer.
			*/
			const refreshConfigHosts = async (silent = false) => {
				if (!silent) setConfigLoading(true);
				const current = configGeneration.current += 1;
				const controller = new AbortController();
				configRequest.current = controller;
				try {
					const value = unwrap(await rpc("config.hosts", {}, controller.signal), "config.hosts failed");
					if (current !== configGeneration.current || controller.signal.aborted) return;
					setConfigHosts(asConfigHosts(value));
					setConfigError(null);
				} catch (error) {
					if (current !== configGeneration.current || controller.signal.aborted) return;
					setConfigError(error instanceof Error ? error.message : String(error));
				} finally {
					if (current === configGeneration.current && !silent) setConfigLoading(false);
				}
			};
			/** Open: refresh both sidebar lists and land on the local home. Closed: abort. */
			(0, react.useEffect)(() => {
				if (!open) {
					generation.current += 1;
					activeRequest.current?.abort();
					activeRequest.current = null;
					configGeneration.current += 1;
					configRequest.current?.abort();
					configRequest.current = null;
					return;
				}
				generation.current += 1;
				setPane(EMPTY_PANE);
				setFolderDraft(null);
				setFormOpen(false);
				setFormDraft(void 0);
				setOpeningRemote(false);
				setDeleteTarget(null);
				setRemovingId(null);
				setHostPending(null);
				setHostError(null);
				setConfirmTarget(null);
				setNativePicking(false);
				setMode({ kind: "local" });
				refreshConnections();
				refreshConfigHosts();
				loadLevel((signal) => listLocalDirectory(void 0, signal));
			}, [open]);
			/** The active connection view (undefined while browsing locally). */
			const activeConnection = mode.kind === "remote" ? connections.find((connection) => connection.id === mode.id) : void 0;
			const activePath = pane.path ?? "";
			const refreshCurrent = () => {
				if (modeRef.current.kind === "local") navigateLocal(paneRef.current.path ?? void 0);
				else navigateRemote(modeRef.current.id, paneRef.current.path ?? void 0);
			};
			/** One OS folder chooser on the host display; a pick lands straight as the workspace. */
			const pickNative = async () => {
				if (mode.kind !== "local" || nativePicking) return;
				setNativePicking(true);
				try {
					const result = unwrap(await rpc("local.pickNative"), "local.pickNative failed");
					const path = isRecord(result) && typeof result.path === "string" ? result.path : "";
					if (path !== "") onPicked(path);
				} catch (error) {
					setPane((previous) => ({
						...previous,
						error: error instanceof Error ? error.message : String(error)
					}));
				} finally {
					setNativePicking(false);
				}
			};
			/** The registry entry a config alias points at, if it was registered before. */
			const matchConfigHost = (host) => connections.find((connection) => connection.port === host.port && (connection.host.toLowerCase() === host.alias.toLowerCase() || connection.host.toLowerCase() === host.host.toLowerCase()));
			const openForm = (draft) => {
				setFormDraft(draft);
				setFormOpen(true);
			};
			/**
			* One click on a config host: switch to its registered entry when there is
			* one; otherwise resolve the alias first. A missing username routes to the
			* prefilled form (the registry refuses empty usernames); anything else asks
			* for confirmation before it is registered and browsed.
			*/
			const activateConfigHost = async (host) => {
				if (hostPending !== null) return;
				const existing = matchConfigHost(host);
				if (existing !== void 0) {
					setHostError(null);
					navigateRemote(existing.id);
					return;
				}
				setHostError(null);
				setHostPending(host.alias);
				try {
					const resolved = asResolved(unwrap(await rpc("connections.resolve", { host: host.alias }), "connections.resolve failed"));
					if (resolved.host === "") throw new Error("别名解析结果为空");
					if (resolved.username.trim() === "") {
						openForm({
							label: host.alias,
							host: resolved.host,
							port: String(resolved.port),
							username: "",
							...resolved.privateKeyPaths[0] !== void 0 ? { privateKeyPath: resolved.privateKeyPaths[0] } : {},
							...resolved.jump.length > 0 ? { jumpText: resolved.jump.map((hop) => `${hop.username !== void 0 && hop.username !== "" ? `${hop.username}@` : ""}${hop.host}${hop.port !== void 0 && hop.port !== 22 ? `:${String(hop.port)}` : ""}`).join(", ") } : {},
							focusUsername: true
						});
						return;
					}
					setConfirmTarget({
						host,
						resolved
					});
				} catch (error) {
					setHostError({
						alias: host.alias,
						message: error instanceof Error ? error.message : String(error)
					});
				} finally {
					setHostPending(null);
				}
			};
			/** Confirmed: register the config host and browse its home right away. */
			const confirmAddHost = async () => {
				if (confirmTarget === null || hostPending !== null) return;
				const { host, resolved } = confirmTarget;
				setHostError(null);
				setHostPending(host.alias);
				try {
					const view = asAddedView(unwrap(await rpc("connections.add", {
						label: host.alias,
						host: resolved.host,
						port: resolved.port,
						username: resolved.username,
						...resolved.privateKeyPaths[0] !== void 0 ? { privateKeyPath: resolved.privateKeyPaths[0] } : {},
						...resolved.jump.length > 0 ? { jump: resolved.jump } : {}
					}), "connections.add failed"));
					if (view.id === "") throw new Error("注册结果缺少连接 id");
					setConfirmTarget(null);
					await refreshConnections(true);
					await refreshConfigHosts(true);
					navigateRemote(view.id);
				} catch (error) {
					setConfirmTarget(null);
					setHostError({
						alias: host.alias,
						message: error instanceof Error ? error.message : String(error)
					});
				} finally {
					setHostPending(null);
				}
			};
			/** A prefilled form for the connection whose browse just failed on auth. */
			const draftFromConnection = (connection) => ({
				label: connection.label,
				host: connection.host,
				port: String(connection.port),
				username: connection.username,
				...connection.jumpHosts.length > 0 ? { jumpText: connection.jumpHosts.join(", ") } : {}
			});
			const confirmCreateFolder = async () => {
				const name = (folderDraft ?? "").trim();
				if (name === "" || pane.path === null) return;
				if (name === "." || name === ".." || /[/\\]/.test(name)) {
					setFolderError("名称不能包含 / 或 \\，也不能是 . 或 ..");
					return;
				}
				setFolderBusy(true);
				setFolderError(null);
				try {
					if (mode.kind === "local") await createLocalDirectory(pane.path, name);
					else unwrap(await rpc("browse.mkdir", {
						id: mode.id,
						path: pane.path,
						name
					}), "browse.mkdir failed");
					setFolderDraft(null);
					refreshCurrent();
				} catch (error) {
					setFolderError(error instanceof Error ? error.message : String(error));
				} finally {
					setFolderBusy(false);
				}
			};
			const confirmRemove = async () => {
				if (deleteTarget === null || removingId !== null) return;
				setRemovingId(deleteTarget.id);
				try {
					unwrap(await rpc("connections.remove", { id: deleteTarget.id }), "connections.remove failed");
					await refreshConnections(true);
					await refreshConfigHosts(true);
					if (mode.kind === "remote" && mode.id === deleteTarget.id) {
						setMode({ kind: "local" });
						loadLevel((signal) => listLocalDirectory(void 0, signal));
					}
				} catch (error) {
					setConnectionsError(error instanceof Error ? error.message : String(error));
				} finally {
					setRemovingId(null);
					setDeleteTarget(null);
				}
			};
			const formResolve = async (host) => unwrap(await rpc("connections.resolve", { host }), "connections.resolve failed");
			const formTest = async (input) => {
				const result = await rpc("connections.test", input);
				if (result.ok) return { ok: true };
				return {
					ok: false,
					message: result.error.message
				};
			};
			const formSave = async (input) => {
				const result = await rpc("connections.add", input);
				if (!result.ok) return {
					ok: false,
					message: result.error.message
				};
				const view = asAddedView(result.value);
				return {
					ok: true,
					...view.id !== "" ? { view } : {}
				};
			};
			const formSaved = async (view) => {
				setFormOpen(false);
				setFormDraft(void 0);
				await refreshConnections(true);
				await refreshConfigHosts(true);
				navigateRemote(view.id);
			};
			const hiddenCount = (pane.listing?.entries ?? []).filter((entry) => entry.hidden).length;
			const visibleEntries = (pane.listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden);
			const home = pane.listing?.home ?? "";
			const crumbs = pane.listing?.crumbs ?? [];
			const lastCrumbIndex = crumbs.length - 1;
			const subtitle = mode.kind === "local" ? "选择一个本机目录作为新工作区" : `正在浏览 ${activeConnection !== void 0 ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}` : mode.id} 的远程目录`;
			/** The translated remote failure for the right pane, when there is one. */
			const remoteFailure = mode.kind === "remote" && pane.error !== null ? describeRemoteFailure(pane.error) : null;
			if (!open) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: flow_module_css_default.overlay,
				onClick: (event) => {
					if (event.target === event.currentTarget) onCancel();
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: flow_module_css_default.dialog,
						role: "dialog",
						"aria-modal": "true",
						"aria-label": "选择工作区目录",
						ref: dialogRef,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
								className: flow_module_css_default.header,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: flow_module_css_default.headerText,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										className: flow_module_css_default.title,
										children: "选择工作区目录"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: flow_module_css_default.subtitle,
										children: subtitle
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: flow_module_css_default.iconButton,
									"aria-label": "关闭",
									onClick: onCancel,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CloseIcon, {})
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: flow_module_css_default.body,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
									className: flow_module_css_default.sidebar,
									"aria-label": "连接与位置",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
											className: flow_module_css_default.sidebarSection,
											"aria-label": "本机",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
												className: flow_module_css_default.connectionList,
												role: "list",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
													className: cx(flow_module_css_default.connectionItem, mode.kind === "local" && flow_module_css_default.connectionItemActive),
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
														type: "button",
														className: flow_module_css_default.connectionMain,
														"aria-current": mode.kind === "local" ? "true" : "false",
														onClick: () => {
															if (mode.kind !== "local") navigateLocal();
														},
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MonitorIcon, { className: flow_module_css_default.connectionIcon }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: flow_module_css_default.connectionInfo,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: flow_module_css_default.connectionLabel,
																children: "本机目录"
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: flow_module_css_default.connectionDetail,
																children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																	className: flow_module_css_default.connectionEndpoint,
																	children: "选择本机目录作为工作区"
																})
															})]
														})]
													})
												})
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
											className: flow_module_css_default.sidebarSection,
											"aria-label": "已保存连接",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", {
													className: flow_module_css_default.sidebarTitle,
													children: ["已保存连接", connections.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: flow_module_css_default.sidebarCount,
														children: connections.length
													})]
												}),
												connectionsLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													role: "status",
													"aria-label": "正在加载已保存连接",
													children: [0, 1].map((index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: flow_module_css_default.skeletonRow,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: flow_module_css_default.skeletonDot }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: flow_module_css_default.skeletonLines,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: flow_module_css_default.skeletonLine,
																style: { width: "38%" }
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: flow_module_css_default.skeletonLine,
																style: { width: "62%" }
															})]
														})]
													}, index))
												}),
												connectionsError !== null && !connectionsLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: flow_module_css_default.sideError,
													role: "alert",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: flow_module_css_default.sideErrorText,
														children: connectionsError
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
														type: "button",
														className: flow_module_css_default.retryButton,
														onClick: () => {
															refreshConnections();
														},
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RefreshIcon, { style: {
															width: 12,
															height: 12
														} }), "重试"]
													})]
												}),
												!connectionsLoading && connectionsError === null && connections.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: flow_module_css_default.sideEmpty,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServerIcon, {
															className: flow_module_css_default.sideEmptyIcon,
															style: {
																width: 18,
																height: 18
															}
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: flow_module_css_default.sideEmptyTitle,
															children: "还没有保存的连接"
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: flow_module_css_default.sideEmptyText,
															children: "点右下角「＋」新建，或从下方 SSH 配置主机一键添加。"
														})
													]
												}),
												!connectionsLoading && connections.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
													className: flow_module_css_default.connectionList,
													role: "list",
													children: connections.map((connection) => {
														const active = mode.kind === "remote" && mode.id === connection.id;
														return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
															className: cx(flow_module_css_default.connectionItem, active && flow_module_css_default.connectionItemActive),
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: flow_module_css_default.connectionMain,
																"aria-current": active ? "true" : "false",
																onClick: () => {
																	navigateRemote(connection.id);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServerIcon, { className: flow_module_css_default.connectionIcon }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																	className: flow_module_css_default.connectionInfo,
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		className: flow_module_css_default.connectionLabel,
																		children: connection.label
																	}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																		className: flow_module_css_default.connectionDetail,
																		children: [
																			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																				className: flow_module_css_default.connectionEndpoint,
																				children: [
																					connection.username,
																					"@",
																					connection.host,
																					":",
																					connection.port
																				]
																			}),
																			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																				className: flow_module_css_default.badge,
																				children: [connection.auth === "password" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LockIcon, { style: {
																					width: 11,
																					height: 11
																				} }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyIcon, { style: {
																					width: 11,
																					height: 11
																				} }), connection.auth === "password" ? "密码" : connection.auth === "agent" ? "Agent" : "私钥"]
																			}),
																			connection.jumpHosts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																				className: flow_module_css_default.badge,
																				title: connection.jumpHosts.join(" → "),
																				children: [
																					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RouteIcon, { style: {
																						width: 11,
																						height: 11
																					} }),
																					"跳板 ×",
																					connection.jumpHosts.length
																				]
																			})
																		]
																	})]
																})]
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: flow_module_css_default.connectionRemove,
																"aria-label": `删除连接 ${connection.label}`,
																title: "删除连接",
																onClick: () => {
																	setDeleteTarget(connection);
																},
																children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrashIcon, { style: {
																	width: 14,
																	height: 14
																} })
															})]
														}, connection.id);
													})
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
											className: flow_module_css_default.sidebarSection,
											"aria-label": "SSH 配置主机",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", {
													className: flow_module_css_default.sidebarTitle,
													children: ["SSH 配置主机", configHosts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: flow_module_css_default.sidebarCount,
														children: configHosts.length
													})]
												}),
												configLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													role: "status",
													"aria-label": "正在读取 ~/.ssh/config",
													children: [0, 1].map((index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: flow_module_css_default.skeletonRow,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: flow_module_css_default.skeletonDot }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: flow_module_css_default.skeletonLines,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: flow_module_css_default.skeletonLine,
																style: { width: "38%" }
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: flow_module_css_default.skeletonLine,
																style: { width: "62%" }
															})]
														})]
													}, index))
												}),
												configError !== null && !configLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: flow_module_css_default.sideError,
													role: "alert",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: flow_module_css_default.sideErrorText,
														children: ["无法读取 ~/.ssh/config：", configError]
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
														type: "button",
														className: flow_module_css_default.retryButton,
														onClick: () => {
															refreshConfigHosts();
														},
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RefreshIcon, { style: {
															width: 12,
															height: 12
														} }), "重试"]
													})]
												}),
												!configLoading && configError === null && configHosts.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: flow_module_css_default.sideEmpty,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: flow_module_css_default.sideEmptyTitle,
														children: "未发现 SSH 配置主机"
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: flow_module_css_default.sideEmptyText,
														children: "在 ~/.ssh/config 中添加 Host 条目后，这里会直接列出，点击即可连接。"
													})]
												}),
												!configLoading && configHosts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
													className: flow_module_css_default.connectionList,
													role: "list",
													children: configHosts.map((host) => {
														const registered = matchConfigHost(host);
														const working = hostPending === host.alias;
														const failed = hostError !== null && hostError.alias === host.alias;
														return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
															className: flow_module_css_default.connectionItem,
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
																type: "button",
																className: flow_module_css_default.connectionMain,
																"aria-current": "false",
																disabled: hostPending !== null,
																title: registered !== void 0 ? `已注册为 ${registered.username}@${registered.host}:${registered.port}` : host.username !== "" ? `${host.username}@${host.host}:${host.port} — 点击注册并浏览` : "未指定用户 — 点击打开表单补全",
																onClick: () => {
																	activateConfigHost(host);
																},
																children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServerIcon, { className: flow_module_css_default.connectionIcon }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																	className: flow_module_css_default.connectionInfo,
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		className: flow_module_css_default.connectionLabel,
																		children: host.alias
																	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																		className: flow_module_css_default.connectionDetail,
																		children: working ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																			className: flow_module_css_default.hostWorking,
																			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: cx(flow_module_css_default.spin, flow_module_css_default.hostSpinner) }), "正在添加并连接…"]
																		}) : failed && hostError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																			className: flow_module_css_default.hostErrorText,
																			role: "alert",
																			children: ["添加失败：", hostError.message]
																		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																			className: flow_module_css_default.connectionEndpoint,
																			children: host.username !== "" ? `${host.username}@${host.host}:${host.port}` : "未指定用户"
																		}), registered !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																			className: cx(flow_module_css_default.badge, flow_module_css_default.badgeAdded),
																			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CheckIcon, { style: {
																				width: 11,
																				height: 11
																			} }), "已添加"]
																		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [host.identityFile && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																			className: flow_module_css_default.badge,
																			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyIcon, { style: {
																				width: 11,
																				height: 11
																			} }), "私钥"]
																		}), host.jump && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
																			className: flow_module_css_default.badge,
																			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RouteIcon, { style: {
																				width: 11,
																				height: 11
																			} }), "跳板"]
																		})] })] })
																	})]
																})]
															})
														}, host.alias);
													})
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: flow_module_css_default.sidebarAdd,
											"aria-label": "新建连接",
											title: "新建连接",
											onClick: () => {
												openForm();
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PlusIcon, { style: {
												width: 14,
												height: 14
											} })
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: flow_module_css_default.main,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: flow_module_css_default.toolbar,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("nav", {
											className: flow_module_css_default.crumbs,
											"aria-label": "当前路径",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: flow_module_css_default.crumb,
												"aria-label": "回到主目录",
												title: "主目录",
												disabled: home === "" || pane.loading,
												onClick: () => {
													if (mode.kind === "local") navigateLocal(home);
													else navigateRemote(mode.id, home);
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HomeIcon, { style: {
													width: 13,
													height: 13,
													verticalAlign: "-2px"
												} })
											}), crumbs.map((crumb, index) => index === lastCrumbIndex ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: flow_module_css_default.crumbCurrent,
												"aria-current": "page",
												title: crumb.path,
												children: crumb.name
											}, crumb.path) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: flow_module_css_default.crumbStep,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: flow_module_css_default.crumb,
													disabled: pane.loading,
													onClick: () => {
														if (mode.kind === "local") navigateLocal(crumb.path);
														else navigateRemote(mode.id, crumb.path);
													},
													children: crumb.name
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: flow_module_css_default.crumbSep,
													"aria-hidden": true,
													children: "/"
												})]
											}, crumb.path))]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: flow_module_css_default.toolbarActions,
											children: [
												mode.kind === "local" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: cx(flow_module_css_default.toolButton, flow_module_css_default.toolButtonText),
													"aria-label": "用系统选择器选择文件夹",
													title: "打开系统文件夹选择器",
													disabled: nativePicking || busy,
													onClick: () => {
														pickNative();
													},
													children: [nativePicking ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FolderIcon, { style: {
														width: 13,
														height: 13
													} }), "系统选择器"]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: flow_module_css_default.toolButton,
													"aria-label": "在当前目录新建文件夹",
													title: "新建文件夹",
													disabled: pane.listing === null || pane.loading,
													onClick: () => {
														setFolderDraft("");
														setFolderError(null);
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FolderPlusIcon, {})
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: cx(flow_module_css_default.toolButton, showHidden && flow_module_css_default.toolButtonOn),
													"aria-pressed": showHidden,
													"aria-label": showHidden ? "隐藏以点开头的文件夹" : "显示以点开头的文件夹",
													title: showHidden ? "隐藏点开头的文件夹" : "显示点开头的文件夹",
													onClick: () => {
														setShowHidden((previous) => !previous);
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(EyeIcon, {}), !showHidden && hiddenCount > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: flow_module_css_default.countBadge,
														"aria-hidden": true,
														children: hiddenCount
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: flow_module_css_default.toolButton,
													"aria-label": "刷新当前目录",
													title: "刷新",
													disabled: pane.loading || pane.listing === null,
													onClick: refreshCurrent,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RefreshIcon, { className: pane.loading ? flow_module_css_default.spin : void 0 })
												})
											]
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: cx(flow_module_css_default.browser, pane.loading && pane.listing !== null && flow_module_css_default.browserBusy),
										"aria-busy": pane.loading,
										children: [
											pane.loading && pane.listing === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: flow_module_css_default.skeletons,
												role: "status",
												"aria-label": "正在加载目录",
												children: [
													52,
													78,
													64,
													90,
													45,
													71
												].map((width, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: flow_module_css_default.skeleton,
													style: { width: `${width}%` }
												}, index))
											}),
											pane.error !== null && !pane.loading && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: flow_module_css_default.errorPanel,
												role: "alert",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AlertIcon, { className: flow_module_css_default.errorIcon }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: flow_module_css_default.errorBody,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: flow_module_css_default.errorTitle,
															children: remoteFailure !== null ? remoteFailure.title : mode.kind === "remote" ? "无法读取远程目录" : "无法读取目录"
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
															className: flow_module_css_default.errorText,
															children: remoteFailure !== null ? remoteFailure.text : pane.error
														})]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: flow_module_css_default.errorActions,
														children: [remoteFailure?.needsAuth === true && activeConnection !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
															type: "button",
															className: flow_module_css_default.retryButton,
															onClick: () => {
																openForm(draftFromConnection(activeConnection));
															},
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyIcon, { style: {
																width: 12,
																height: 12
															} }), "补全认证"]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
															type: "button",
															className: flow_module_css_default.retryButton,
															onClick: refreshCurrent,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RefreshIcon, { style: {
																width: 12,
																height: 12
															} }), "重试"]
														})]
													})
												]
											}),
											pane.listing !== null && visibleEntries.length === 0 && !pane.loading && pane.error === null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: flow_module_css_default.emptyState,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FolderIcon, {
														className: flow_module_css_default.emptyIcon,
														style: {
															width: 22,
															height: 22
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: flow_module_css_default.emptyTitle,
														children: "没有子文件夹"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: flow_module_css_default.emptyText,
														children: hiddenCount > 0 && !showHidden ? `另有 ${hiddenCount} 个点开头的文件夹未显示` : "可直接在此目录新建文件夹，或选择上方路径"
													})
												]
											}),
											visibleEntries.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
												className: flow_module_css_default.entryList,
												role: "list",
												children: visibleEntries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: cx(flow_module_css_default.entry, entry.hidden && flow_module_css_default.entryHidden),
													onClick: () => {
														if (mode.kind === "local") navigateLocal(entry.path);
														else navigateRemote(mode.id, entry.path);
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FolderIcon, { className: flow_module_css_default.entryIcon }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: flow_module_css_default.entryName,
															children: entry.name
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronIcon, { className: flow_module_css_default.entryChevron })
													]
												}) }, entry.path))
											}),
											pane.listing?.truncated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: flow_module_css_default.truncated,
												children: "文件夹过多，仅显示开头部分。"
											})
										]
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
								className: flow_module_css_default.footer,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: flow_module_css_default.button,
									disabled: busy,
									onClick: onCancel,
									children: "取消"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: cx(flow_module_css_default.button, flow_module_css_default.primary),
									disabled: pane.listing === null || pane.loading || busy || openingRemote || pane.path === null,
									onClick: () => {
										if (pane.path === null) return;
										if (mode.kind === "local") onPicked(pane.path);
										else openRemotePath();
									},
									children: [mode.kind === "remote" && openingRemote && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }), mode.kind === "remote" ? openingRemote ? "连接中…" : "连接并打开" : "选择目录"]
								})]
							})
						]
					}),
					folderDraft !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: flow_module_css_default.overlay,
						onClick: (event) => {
							if (event.target === event.currentTarget && !folderBusy) setFolderDraft(null);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: flow_module_css_default.smallDialog,
							role: "dialog",
							"aria-modal": "true",
							"aria-label": "新建文件夹",
							ref: folderDialogRef,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: flow_module_css_default.formTitle,
									children: "新建文件夹"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: flow_module_css_default.createIn,
									children: ["位置：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: cx(flow_module_css_default.mono, flow_module_css_default.createPath),
										children: activePath === "" ? "…" : activePath
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: cx(flow_module_css_default.input, folderError !== null && flow_module_css_default.inputError),
									value: folderDraft,
									placeholder: "未命名文件夹",
									disabled: folderBusy,
									onChange: (event) => {
										setFolderDraft(event.target.value);
									},
									onKeyDown: (event) => {
										if (event.key === "Enter" && !folderBusy) confirmCreateFolder();
									}
								}),
								folderError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: flow_module_css_default.fieldError,
									role: "alert",
									children: folderError
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: flow_module_css_default.formActions,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: flow_module_css_default.gap }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: flow_module_css_default.button,
											disabled: folderBusy,
											onClick: () => {
												setFolderDraft(null);
											},
											children: "取消"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: cx(flow_module_css_default.button, flow_module_css_default.primary),
											disabled: folderBusy || (folderDraft ?? "").trim() === "",
											onClick: () => {
												confirmCreateFolder();
											},
											children: [folderBusy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }), "创建"]
										})
									]
								})
							]
						})
					}),
					deleteTarget !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: flow_module_css_default.overlay,
						onClick: (event) => {
							if (event.target === event.currentTarget && removingId === null) setDeleteTarget(null);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: flow_module_css_default.smallDialog,
							role: "dialog",
							"aria-modal": "true",
							"aria-label": "删除远程连接",
							ref: deleteDialogRef,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: flow_module_css_default.confirmHead,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: flow_module_css_default.confirmIconWrap,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrashIcon, {})
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									className: flow_module_css_default.formTitle,
									children: [
										"删除连接「",
										deleteTarget.label,
										"」？"
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: flow_module_css_default.confirmText,
									children: [
										"将移除 ",
										deleteTarget.username,
										"@",
										deleteTarget.host,
										":",
										deleteTarget.port,
										" 的注册信息；删除后需要重新添加才能再次连接。"
									]
								})] })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: flow_module_css_default.formActions,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: flow_module_css_default.gap }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: flow_module_css_default.button,
										disabled: removingId !== null,
										onClick: () => {
											setDeleteTarget(null);
										},
										children: "取消"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: cx(flow_module_css_default.button, flow_module_css_default.danger),
										disabled: removingId !== null,
										onClick: () => {
											confirmRemove();
										},
										children: [removingId !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }), "删除"]
									})
								]
							})]
						})
					}),
					confirmTarget !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: flow_module_css_default.overlay,
						onClick: (event) => {
							if (event.target === event.currentTarget && hostPending === null) setConfirmTarget(null);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: flow_module_css_default.smallDialog,
							role: "dialog",
							"aria-modal": "true",
							"aria-label": "添加 SSH 配置主机",
							ref: confirmDialogRef,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: flow_module_css_default.confirmHead,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: cx(flow_module_css_default.confirmIconWrap, flow_module_css_default.confirmIconInfo),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ServerIcon, {})
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
									className: flow_module_css_default.formTitle,
									children: [
										"添加连接「",
										confirmTarget.host.alias,
										"」？"
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: flow_module_css_default.confirmText,
									children: [
										"将把 ",
										confirmTarget.resolved.username,
										"@",
										confirmTarget.resolved.host,
										":",
										confirmTarget.resolved.port,
										confirmTarget.resolved.jump.length > 0 ? `（经 ${String(confirmTarget.resolved.jump.length)} 级跳板）` : "",
										"保存到「已保存连接」，并打开它的远程目录。"
									]
								})] })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: flow_module_css_default.formActions,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: flow_module_css_default.gap }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: flow_module_css_default.button,
										disabled: hostPending !== null,
										onClick: () => {
											setConfirmTarget(null);
										},
										children: "取消"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: cx(flow_module_css_default.button, flow_module_css_default.primary),
										disabled: hostPending !== null,
										onClick: () => {
											confirmAddHost();
										},
										children: [hostPending !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SpinnerIcon, { className: flow_module_css_default.spin }), "添加并连接"]
									})
								]
							})]
						})
					}),
					formOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectionForm, {
						resolve: formResolve,
						test: formTest,
						save: formSave,
						draft: formDraft,
						onClose: () => {
							setFormOpen(false);
							setFormDraft(void 0);
						},
						onSaved: (view) => {
							formSaved(view);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required client services: the slot registry and the wire-facing workspace browser service. */
		const inject = ["slots", "uiWorkspace"];
		/**
		* Client plugin body: fill both directory-flow holes with the SSH workspace
		* flow. `slots.inject` waits for each hole's declaration, and the generator
		* installs the two registrations transactionally.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const injected = () => ({
				listLocalDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
				createLocalDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
				rpc: (endpoint, payload, signal) => {
					const connection = ctx.get("connection");
					if (connection === void 0) return Promise.resolve({
						ok: false,
						error: {
							code: "internal",
							message: "dsh-ssh: the web transport is not available"
						}
					});
					return connection.rpc.call("/dsh-ssh", endpoint, payload ?? {}, signal);
				}
			});
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				yield ctx.slots.register({
					name: "conversation.hero.workspace.directoryFlow",
					inject: injected
				}, SshWorkspaceFlow);
				yield ctx.slots.register({
					name: "sidebar.workspaces.directoryFlow",
					inject: injected
				}, SshWorkspaceFlow);
			}));
			const sidebar = ctx.get("betterSidebar");
			if (sidebar !== void 0) ctx.effect(() => {
				const rpc = (endpoint, payload, signal) => {
					const connection = ctx.get("connection");
					if (connection === void 0) return Promise.resolve({
						ok: false,
						error: {
							code: "internal",
							message: "dsh-ssh: transport unavailable"
						}
					});
					return connection.rpc.call("/dsh-ssh", endpoint, payload ?? {}, signal);
				};
				const disposeTab = sidebar.registerTab({
					id: "dsh-remote-ssh:remote-files",
					type: "dsh-remote-ssh:remote-files",
					title: "Remote Files",
					component: () => RemoteFileBrowser({ rpc })
				});
				return () => {
					disposeTab();
				};
			}, "dsh-ssh: better-sidebar remote-files tab");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map