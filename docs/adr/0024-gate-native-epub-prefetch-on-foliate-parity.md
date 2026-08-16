# ADR-0024：以 Foliate 语义 parity gate 控制 EPUB 原生预取

## 状态

已接受。

## 背景

EPUB 的元数据、封面、目录、spine、资源解析和 CFI 行为必须与阅读渲染器保持一致。平台侧可以更快地读取托管 ZIP 的入口 XML 和资源尺寸，但如果 Rust 侧同时实现 EPUB 语义，就会产生两套解析结果，导致目录、章节顺序或续读位置漂移。

## 决策

1. `foliate-js` 是 EPUB 语义唯一来源。TypeScript 通过 `BookDocument`/Foliate loader 获取元数据、封面、目录、spine、资源和 CFI。
2. Rust 只提供机械预取：ZIP 中央目录尺寸、`META-INF/container.xml`、OPF、可声明的 NAV/NCX 字节；不构造 BookDocument、TOC、spine 或 CFI。
3. 原生结果必须携带协议版本、`semanticSource: foliate-js`、目标平台、`validated` 和能力清单。前端只有在协议、语义来源、能力集合及平台均通过 gate 时才使用预取；当前已验证平台为 Windows，未验证平台使用纯 JS。
4. 预取命令、桥接或 Foliate loader 失败时，在创建渲染器前丢弃原生结果并重建纯 JS loader。错误不得留下部分 native 状态，也不得与 JS 结果合并成第二套导航/位置对象。
5. parity 测试使用同一个 Foliate EPUB 实现，比较纯 JS 与预取路径的元数据、封面、目录、章节顺序/线性属性/大小、CFI 和错误分类；资源正文仍由统一 JS ZIP loader 按需读取。

## 后果

- 已验证平台可以预取小型入口资源和尺寸信息，而不改变阅读语义。
- 新平台或新能力必须先补齐 parity fixture 与契约测试，再扩大 `validated` 平台集合。
- Rust 需要维护 ZIP/XML/百分号路径的边界预算，但不承担 EPUB 语义兼容性；Foliate 升级仍由 TypeScript 侧 parity 测试把关。
