TOPF: Temperate Optimal Power Flow
==================================

[![Build Status](https://github.com/gillioz/TemperateOptimalPowerFlow.jl/actions/workflows/CI.yml/badge.svg?branch=main)](https://github.com/gillioz/TemperateOptimalPowerFlow.jl/actions/workflows/CI.yml?query=branch%3Amain)


This package implements a "temperate" Optimal Power Flow (OPF) algorithm
that dispatches production sources in a power system while disfavoring heavily-loaded lines.

Line cost function
------------------

The core of the algorithm is to assign a cost to each line of the power grid
that is proportional to the square of the line's loading rate.
In this way, the optimal power flow becomes a convex optimization problem
that can be solved with standard methods.

Given the power $P_i$ flowing through a line with index $i$,
and the thermal limit of the line $P_i^{th}$,
the loading rate $R_i$ of the line is given by the formula

$R_i = | P_i | / P_i^{th}$

We define the cost associated with line $i$ to be the square of the loading rate,
weighted by the line's thermal limit:

$P_i^{th} R_i^2$

Using the definition of the loading rate, this is equivalent to:

$P_i^2 / P_i^{th}$

This cost is independent of the sign of the power $P_i$, which depends on the line's direction.

Other features
--------------

In addition to the quadratic line cost, a conventional, linear production cost can be associated
with each generator in order to model the contingencies of power production
and introduce some realistic noise in the optimization process.

The TOPF algorithm also supports constraints that ensures a given total production
over a certain period of time for every individual generator.


Installation
------------

The package can be installed with
```julia
] add TemperateOptimalPowerFlow
```

You can test the installation by running
```julia
] test TemperateOptimalPowerFlow
```


Usage
-----

To begin, import a model in [MatPower](https://www.pserc.cornell.edu/matpower/)
or [PowerModels](https://lanl-ansi.github.io/PowerModels.jl/stable/network-data/) format.
For instance, working the package's directory, one can use:

```julia
using TemperateOptimalPowerFlow
network = import_model("test/switzerland.json")
```

or

```julia
using TemperateOptimalPowerFlow, PowerModels
network = parse_file("test/case3.m")
prepare_model!(network)
```

If the model is imported with the *PowerModels* `parse_file` method,
it is necessary to run the command `prepare_model!` that adds some features to the model.
In particular, it ensures that the model contains an *expected generation value* `pexp`
for each generator,  which must be a fraction of the generator's capacity `pmax`
(if missing, this is set to 50% of the capacity by default).

The optimal power flow computation is then setup with the command
```julia
setup(directory, network, loads, gen_costs)
```
where
- `directory` is a path to a directory to be created, in which computation files will be placed;
- `network` is the network object imported before;
- `loads` is a matrix that contain time series for each load of the model, arranged as rows;
- `gen_costs` is a similar matrix with one row for each generator of the model,
  containing the variable generation cost of that generator.

Several files are generated in the relevant directory.
To perform the actual optimal power flow computation,
one needs to import an optimizer such as [HiGHS](https://highs.dev/) (open source)
or [Ipopt](https://github.com/coin-or/Ipopt) (open source),
or otherwise provide a `get_optimizer()` method that returns an optimizer
in the [MathOptInterface](https://jump.dev/MathOptInterface.jl/stable/) format.
Then the computation can be launched with
```julia
using Ipopt
compute(directory)
```

**WARNING**: For large models and/or long time series the computation can be slow (several hours!) and memory-intensive. 
It is recommended to partition the optimal power flow computation into smaller parts.
For instance, a time series of 8736 time steps (364 days x 24 hours) can be partitioned into
52 weeks of 168 time steps using
```julia
compute(directory, "P_result_52x168", [52, 168])
```
or partitioned further into 13 "months" of 28 days of 24 hours as
```julia
compute(directory, "P_result_13x28x24", [13, 28, 24])
```
The second argument in both cases indicates the name of the result file.

Once the computation is done, the results can be accessed with
```julia
retrieve_gen_results(directory, "P_result_13x28x24")
```
returning a matrix of time series in which each row corresponds to a generator of the model.
The ordered list of generators can be obtained with
```julia
get_ordered_gen_ids(network)
```

Similarly, the power flowing through the lines of the network can be accessed with
```julia
retrieve_line_flows(directory, "P_result_13x28x24")
```
where the rows correspond to the line IDs of
```julia
get_ordered_line_ids(network)
```



A more complete description of the package's possibilities can be found in the
[PowerData repository](https://github.com/GeeeHesso/PowerData/tree/main/run).
