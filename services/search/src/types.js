// Shared plain-data types used by the indexing pipeline, HTTP API and tests.

/**
 * @typedef {'title'|'apiName'|'errorCode'|'body'} FieldName
 * @typedef {'natural'|'code'} AnalyzerName
 *
 * @typedef {Object} SectionInput
 * @property {string} docId
 * @property {string} version
 * @property {string} sectionId
 * @property {string} title
 * @property {string} apiName
 * @property {string} errorCode
 * @property {string} bodyHtml
 * @property {string} urlPath
 * @property {string} anchor
 * @property {number} [ordinal]
 *
 * @typedef {Object} AuthContext
 * @property {string} userId
 * @property {string[]} [groups]
 *
 * @typedef {Object} HighlightRange
 * @property {number} start UTF-16 offset in the returned plain-text field.
 * @property {number} end   UTF-16 offset in the returned plain-text field.
 *
 * @typedef {Object} SearchHit
 * @property {string} docId
 * @property {string} version
 * @property {string} sectionId
 * @property {'current'|'historical'} versionState
 * @property {string} title
 * @property {string} apiName
 * @property {string} errorCode
 * @property {string} url
 * @property {number} score
 * @property {Object.<FieldName, HighlightRange[]>} highlights
 * @property {Object.<FieldName, string>} fields
 * @property {{text:string, start:number,end:number,field:FieldName,highlights:HighlightRange[]}|null} snippet
 * @property {{generationId:string, publishedAt:string}} [generation]
 *
 * @typedef {Object} SearchResult
 * @property {SearchHit[]} hits
 * @property {{next:(string|null), hasMore:boolean}} page
 * @property {{version:string, generationId:string, generationStatus:string, isCurrent:boolean, totalCandidates:number, cursorStale?:boolean}} meta
 */
