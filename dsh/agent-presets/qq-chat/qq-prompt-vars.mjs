// re-export 壳：qq-prompt-vars 的权威实现只有一份，在
// plugins/qq-agent-presets/qq-prompt-vars.mjs（bundle 内，preset 行按包名引用）。
//
// 作用与 qq-tool-restrict.mjs 的同名壳一致：让仓库里按老路径（preset 目录）
// import/读文件的脚本继续工作，并且明确指向唯一实现，避免出现两份会漂移的实现。
export * from '../../../plugins/qq-agent-presets/qq-prompt-vars.mjs'
