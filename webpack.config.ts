import * as webpack from 'webpack';
import nodeExternals from 'webpack-node-externals';
import path from 'path';
import tsTransformPaths from '@zerollup/ts-transform-paths';

// @ts-ignore
import DtsBundleWebpack from 'dts-bundle-webpack';

const config: webpack.Configuration = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: {
    index: './src/index.ts',
    cli: 'src/cli/index',
  },
  target: 'node',
  externals: [nodeExternals()],
  output: {
    path: path.resolve(__dirname, 'lib'),
    filename: '[name].js',
    library: 'prolink-connect',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {src: path.join(__dirname, 'src')},
  },
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        test: /\.ksy$/,
        use: ['kaitai-struct-loader'],
      },
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: 'ts-loader',
        options: {
          getCustomTransformers: (program: any) => {
            const transformer = tsTransformPaths(program);
            return {
              before: [transformer.before],
              afterDeclarations: [transformer.afterDeclarations],
            };
          },
        },
      },
    ],
  },
  plugins: [
    new DtsBundleWebpack({
      name: 'prolink-connect',
      main: path.resolve(__dirname, 'lib/src/index.d.ts'),
      out: path.resolve(__dirname, 'lib/index.d.ts'),
    }),
  ],
};

export default config;
