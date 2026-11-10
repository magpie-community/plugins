// 定制构建入口：只包含看板用到的图表与组件（见第四轮瘦身分析）。
// 重建命令：npx esbuild build/echarts-entry.mjs --bundle --minify --global-name=echarts
//           --outfile=static/echarts.min.js
// 页面通过全局 echarts.init(...) 使用；新增图表类型时在此补 import 并重建。
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, HeatmapChart } from 'echarts/charts';
import {
  TooltipComponent, LegendComponent, GridComponent, DataZoomComponent,
  DataZoomInsideComponent, DataZoomSliderComponent, VisualMapComponent,
  AxisPointerComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart, LineChart, PieChart, HeatmapChart,
  TooltipComponent, LegendComponent, GridComponent, DataZoomComponent,
  DataZoomInsideComponent, DataZoomSliderComponent, VisualMapComponent,
  AxisPointerComponent, CanvasRenderer,
]);

// 页面通过全局 echarts.init(...) 使用；--global-name 的 iife 会把 default export
// 嵌套进 .default，这里直接赋值保证 window.echarts 就是完整命名空间
if (typeof window !== 'undefined') window.echarts = echarts;
export default echarts;
