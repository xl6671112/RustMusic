export type JizuraSettings = {
  project?: Record<string, unknown>;
  transparent: boolean;
  sourceTrackKey?: string;
  lineEffectsTrackKey?: string;
  fontFiles?: Record<string,string>;
  analysis?: {
    duration: number;
    bpm: number;
    beats: number[];
    energy: number[];
    energyRate: number;
    sourceTrackKey?: string;
  };
};

export const initialJizuraSettings:JizuraSettings={transparent:true};

export const JIZURA_STYLES=[
  {id:"noir",label:"黑白色差"},{id:"crimson",label:"深红信号"},{id:"caution",label:"警示"},
  {id:"magenta",label:"波普洋红"},{id:"paper",label:"纸与墨"},{id:"hud",label:"暗色 HUD"},
  {id:"mint",label:"薄荷终端"},{id:"specimen",label:"字体样本"},{id:"transit",label:"交通标识"},
  {id:"blueprint",label:"蓝图"},{id:"rouge",label:"胭脂渐变"},{id:"mono",label:"单色 RGB"},
  {id:"hrRuin",label:"废墟"},{id:"hrNightRec",label:"深夜录像"},{id:"hrCurse",label:"诅咒之信"},
  {id:"sakura",label:"樱花"},{id:"ocean",label:"深海"},{id:"sunset",label:"日落渐变"},
  {id:"forest",label:"森林笔记"},{id:"vapor",label:"蒸汽波"},{id:"newsprint",label:"新闻纸"},
  {id:"synth80",label:"80 年代合成器"},{id:"kraft",label:"牛皮纸"},{id:"candy",label:"糖果"},
  {id:"acid",label:"酸性"},{id:"sumi",label:"墨与朱"},{id:"gold",label:"金色之夜"},
];

export function createJizuraSettings(style="noir",current?:JizuraSettings):JizuraSettings {
  return {...initialJizuraSettings,...current,project:{...current?.project,style}};
}
